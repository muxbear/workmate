import { randomInt } from 'crypto'
import type { ILocalAuthStore, UserRecord } from '../database/interfaces/ILocalAuthStore'
import { sha256, verifyPassword } from '../security/crypto'
import { signToken, type TokenPayload } from '../security/token'
import type { ISecureStorage } from '../security/secure-storage'
import type { OAuth2Token, OAuth2WebUser } from '../oauth2/types'

export interface AuthResult {
  token: string
  refreshToken: string
  user: { id: string; username: string; mobile?: string }
}

export interface AuthServiceDeps {
  /** 本地认证存储：密码/短信/微信登录、OAuth2 账号关联均读写本地 users/sms/oauth2_sessions */
  repository: ILocalAuthStore
  jwtSecret: string
  secureStorage: ISecureStorage
  now?: () => number
  smsSender?: { send(mobile: string, code: string): Promise<void> }
  wechatClient?: { exchangeCode(code: string): Promise<string> }
  maxFailedAttempts?: number
  lockDurationMs?: number
  smsCodeTtlMs?: number
  accessTokenTtlSec?: number
  refreshTokenTtlSec?: number
}

export interface OAuth2LoginResult {
  status: 'logged-in' | 'needs-confirmation'
  user?: { id: string; username: string }
  action?: 'created' | 'linked' | 'switch-identity' | 'rebind'
  message?: string
}

const ACCESS_TTL_SEC = 2 * 60 * 60
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60
/** 昵称长度上限（UTF-16 码元，与渲染层输入框 maxlength 一致） */
const NICKNAME_MAX_LEN = 20

export class AuthService {
  private readonly repo: ILocalAuthStore
  private readonly secret: string
  private readonly now: () => number
  private readonly smsSender: { send(mobile: string, code: string): Promise<void> }
  private readonly wechatClient: { exchangeCode(code: string): Promise<string> }
  private readonly maxFailedAttempts: number
  private readonly lockDurationMs: number
  private readonly smsCodeTtlMs: number
  private readonly accessTokenTtlSec: number
  private readonly refreshTokenTtlSec: number

  constructor(deps: AuthServiceDeps) {
    this.repo = deps.repository
    this.secret = deps.jwtSecret
    this.now = deps.now ?? Date.now
    this.smsSender = deps.smsSender ?? { send: async () => {} }
    this.wechatClient = deps.wechatClient ?? { exchangeCode: async () => '' }
    this.maxFailedAttempts = deps.maxFailedAttempts ?? 5
    this.lockDurationMs = deps.lockDurationMs ?? 15 * 60 * 1000
    this.smsCodeTtlMs = deps.smsCodeTtlMs ?? 5 * 60 * 1000
    this.accessTokenTtlSec = deps.accessTokenTtlSec ?? ACCESS_TTL_SEC
    this.refreshTokenTtlSec = deps.refreshTokenTtlSec ?? REFRESH_TTL_SEC
  }

  // ── 会话资料 ──

  /**
   * 按用户 id 读取展示资料（渲染层用户名展示用）。
   * 主进程会话是唯一权威：渲染层 localStorage 可能残留上一账号的 user_info，
   * 由 session:check 每次带回权威资料纠正。
   */
  async getProfileById(
    userId: string
  ): Promise<{ id: string; username: string; mobile?: string; nickname?: string } | null> {
    const user = await this.repo.findById(userId)
    if (!user) return null
    return {
      id: user.id,
      username: user.username,
      mobile: user.mobile ?? undefined,
      nickname: user.nickname ?? undefined
    }
  }

  /**
   * 更新本地昵称（账户管理页自助编辑）。
   * 空串/纯空白 = 清除昵称（落库 NULL，显示名回退 username/mobile）。
   * 返回更新后的权威资料，供渲染层 syncFromSession 一次同步。
   */
  async updateNickname(
    userId: string,
    raw: string
  ): Promise<{ id: string; username: string; mobile?: string; nickname?: string }> {
    const profile = await this.getProfileById(userId)
    if (!profile) throw new Error('账号不存在')
    const trimmed = raw.trim()
    if (trimmed.length > NICKNAME_MAX_LEN) {
      throw new Error(`昵称不能超过 ${NICKNAME_MAX_LEN} 个字符`)
    }
    // IPC 是信任边界：输入框无法输入控制字符，但通道可被任意调用
    const hasControlChar = [...trimmed].some((ch) => {
      const code = ch.codePointAt(0)
      return code !== undefined && (code < 0x20 || code === 0x7f)
    })
    if (hasControlChar) throw new Error('昵称不能包含非法字符')
    const next = trimmed === '' ? null : trimmed
    await this.repo.updateNickname(userId, next)
    await this.repo.addAuditLog({
      userId,
      action: 'update_nickname',
      detail: JSON.stringify({ nickname: next })
    })
    return { ...profile, nickname: next ?? undefined }
  }

  // ── 密码登录 ──

  async loginByPassword(account: string, password: string): Promise<AuthResult> {
    const user = await this.repo.findByAccount(account)
    if (!user) {
      // 统一错误消息，防用户枚举
      await this.repo.addAuditLog({ action: 'login_failed', detail: 'account not found' })
      throw new Error('账号或密码错误')
    }
    this.assertNotLocked(user)

    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) {
      await this.handleLoginFailure(user)
      throw new Error('账号或密码错误')
    }

    await this.repo.resetLoginFailures(user.id)
    return this.completeLogin(user, 'login')
  }

  // ── 短信登录 ──

  async sendSmsCode(mobile: string): Promise<void> {
    if (!/^1[3-9]\d{9}$/.test(mobile)) {
      throw new Error('手机号格式不正确')
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const codeHash = sha256(code)
    await this.repo.saveSmsCode(mobile, codeHash, this.now() + this.smsCodeTtlMs)
    await this.smsSender.send(mobile, code)
    await this.repo.addAuditLog({ action: 'sms_code_sent', detail: mobile })
  }

  async loginBySms(mobile: string, code: string): Promise<AuthResult> {
    const record = await this.repo.findSmsCode(mobile)
    if (!record || record.used || record.expiresAt <= this.now()) {
      throw new Error('验证码无效或已过期')
    }
    if (sha256(code) !== record.codeHash) {
      throw new Error('验证码错误')
    }
    await this.repo.markSmsCodeUsed(mobile)

    let user = await this.repo.findByMobile(mobile)
    if (!user) {
      user = await this.repo.createUser({ username: mobile, mobile })
    }
    this.assertNotLocked(user)
    await this.repo.resetLoginFailures(user.id)
    return this.completeLogin(user, 'login_sms')
  }

  // ── 微信登录 ──

  async loginByWechat(code: string): Promise<AuthResult> {
    const openid = await this.wechatClient.exchangeCode(code)
    if (!openid) throw new Error('微信授权失败')

    let user = await this.repo.findByWechatOpenid(openid)
    if (!user) {
      user = await this.repo.createUser({
        username: `wx_${sha256(openid).slice(0, 12)}`,
        wechatOpenid: openid
      })
    }
    this.assertNotLocked(user)
    await this.repo.resetLoginFailures(user.id)
    return this.completeLogin(user, 'login_wechat')
  }

  // ── OAuth2 Web 账号登录 ──

  /**
   * OAuth2 登录后的本地账号关联（方案 7.3 四分支）。
   *
   * 分支：
   * - 无绑定 + 无当前登录 → 新建 web-only 用户；
   * - 已绑定 + （无当前登录 或 当前 == 绑定用户）→ 直接登录；
   * - 无绑定 + 当前用户已绑定其他 Web 账号 → 换绑（需确认）；
   * - 无绑定 + 当前用户未绑定（或已绑定其他用户）→ 新建并切换登录（需确认）。
   *
   * 需要确认时返回 needs-confirmation，调用方确认后以 confirm=true 重调。
   */
  async loginByOAuth2(
    webUser: OAuth2WebUser,
    token: OAuth2Token,
    currentUserId: string | null,
    confirm: boolean
  ): Promise<OAuth2LoginResult> {
    const byWeb = await this.repo.findByWebAccountId(webUser.id)
    const current = currentUserId
      ? await this.repo.findById(currentUserId)
      : null

    let target: UserRecord
    let action: 'created' | 'linked' | 'switch-identity' | 'rebind'

    if (!byWeb) {
      if (!current) {
        target = await this.createWebOnlyUser(webUser)
        action = 'created'
      } else if (current.webAccountId) {
        // 当前用户已绑定其他 Web 账号 → 换绑（撤销旧 token 由调用方处理）
        if (!confirm) {
          return {
            status: 'needs-confirmation',
            action: 'rebind',
            message:
              '当前本地账号已绑定其他 Web 账号，换绑后旧 Web 账号的登录凭证将被撤销，且本地数据边界会随绑定变化。确认换绑？'
          }
        }
        await this.repo.unlinkWebAccount(current.id)
        await this.repo.linkWebAccount({
          userId: current.id,
          webAccountId: webUser.id,
          webNickname: webUser.nickname,
          webAvatar: webUser.avatar
        })
        target = current
        action = 'rebind'
      } else {
        // 当前用户未绑定任何 Web 账号 → 新建该 Web 账号的用户并切换登录
        if (!confirm) {
          return {
            status: 'needs-confirmation',
            action: 'switch-identity',
            message:
              '将新建该 Web 账号对应的本地用户，并切换当前登录身份（当前本地账号的绑定保持不变）。确认继续？'
          }
        }
        target = await this.createWebOnlyUser(webUser)
        action = 'switch-identity'
      }
    } else {
      if (!current || current.id === byWeb.id) {
        target = byWeb
        action = 'linked'
      } else {
        // Web 账号已绑定其他本地用户 → 切换登录到绑定用户
        if (!confirm) {
          return {
            status: 'needs-confirmation',
            action: 'switch-identity',
            message:
              '该 Web 账号已绑定另一个本地用户，继续将切换登录到该本地用户（不影响绑定关系）。确认继续？'
          }
        }
        target = byWeb
        action = 'switch-identity'
      }
      await this.repo.linkWebAccount({
        userId: target.id,
        webAccountId: webUser.id,
        webNickname: webUser.nickname,
        webAvatar: webUser.avatar
      })
    }

    // 完成登录：更新 token 摘要、写入会话索引与审计
    await this.repo.updateToken(target.id, sha256(token.accessToken), token.expiresAt)
    await this.repo.saveOAuth2Session({
      localUserId: target.id,
      webAccountId: webUser.id,
      scope: token.scope,
      expiresAt: token.expiresAt
    })
    await this.repo.addAuditLog({
      userId: target.id,
      action: 'oauth2_login',
      detail: JSON.stringify({ webAccountId: webUser.id, action })
    })
    return {
      status: 'logged-in',
      user: { id: target.id, username: target.username },
      action
    }
  }

  // ── 登出 ──

  /** 登出：清除 token 哈希并记录审计 */
  async logout(account: string): Promise<void> {
    const user = await this.repo.findByAccount(account)
    if (user) {
      await this.repo.updateToken(user.id, null, null)
      await this.repo.clearOAuth2Session(user.id)
      await this.repo.addAuditLog({ userId: user.id, action: 'logout' })
    }
  }

  /** 查询本地用户与 Web 账号的绑定状态 */
  async getOAuth2Status(
    localUserId: string
  ): Promise<{ linked: boolean; webAccountId: string | null }> {
    const user = await this.repo.findById(localUserId)
    return {
      linked: Boolean(user?.webAccountId),
      webAccountId: user?.webAccountId ?? null
    }
  }

  // ── 内部工具 ──

  private assertNotLocked(user: UserRecord): void {
    if (user.lockedUntil && user.lockedUntil > this.now()) {
      const minutes = Math.ceil((user.lockedUntil - this.now()) / 60000)
      throw new Error(`账户已锁定，请 ${minutes} 分钟后再试`)
    }
  }

  private async handleLoginFailure(user: UserRecord): Promise<void> {
    const { lockedUntil } = await this.repo.recordLoginFailure(
      user.id,
      this.maxFailedAttempts,
      this.lockDurationMs,
      this.now()
    )
    await this.repo.addAuditLog({
      userId: user.id,
      action: 'login_failed',
      detail: JSON.stringify({ locked: Boolean(lockedUntil) })
    })
  }

  private async completeLogin(user: UserRecord, action: string): Promise<AuthResult> {
    const payload: TokenPayload = { sub: user.id, mode: 'local' }
    const token = signToken(payload, this.secret, { expiresInSec: this.accessTokenTtlSec })
    const refreshToken = signToken({ ...payload, type: 'refresh' } as never, this.secret, {
      expiresInSec: this.refreshTokenTtlSec
    })
    const expireAt = this.now() + this.accessTokenTtlSec * 1000
    await this.repo.updateToken(user.id, sha256(token), expireAt)
    await this.repo.addAuditLog({ userId: user.id, action })
    return {
      token,
      refreshToken,
      user: { id: user.id, username: user.username, mobile: user.mobile }
    }
  }

  private async createWebOnlyUser(webUser: OAuth2WebUser): Promise<UserRecord> {
    return this.repo.createWebOnlyUser({
      webAccountId: webUser.id,
      webNickname: webUser.nickname,
      webAvatar: webUser.avatar
    })
  }
}
