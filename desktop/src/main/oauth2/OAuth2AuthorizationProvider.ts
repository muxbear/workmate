import type { WebUser } from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import type { OAuth2ClientService } from './OAuth2ClientService'
import { DESKTOP_DEFAULT_SCOPES } from './scopes'
import type { OAuth2Token, OAuth2WebUser } from './types'

/** 统一 OAuth2 会话 token 的 secureStorage key（一个本地用户一份） */
export function oauth2SessionTokenKey(localUserId: string): string {
  return `oauth2-session:${localUserId}:tokens`
}

/** 历史分功能 token key 前缀（首次使用时迁移到统一 key） */
export const LEGACY_TOKEN_KEY_PREFIXES = ['skill-sync:', 'expert-sync:', 'model-sync:'] as const

/** 标记「token 由历史分功能 token 迁移而来」的 secureStorage key */
function legacyPartialKey(localUserId: string): string {
  return `oauth2-partial:${localUserId}`
}

export interface OAuth2AuthorizationSnapshot {
  /** 所需 scope 是否已全部授予 */
  status: 'authorized' | 'unauthorized'
  webUser: OAuth2WebUser | null
  grantedScopes: string[]
  missingScopes: string[]
}

export interface EnsureAuthorizationOptions {
  /** 触发授权的原因（日志用） */
  reason?: string
}

export interface OAuth2AuthorizationProviderDeps {
  oauth2Client: OAuth2ClientService
  secureStorage: ISecureStorage
  /** 默认请求的 scope 集合；缺省为桌面默认权限集合（测试可注入） */
  defaultScopes?: readonly string[]
}

/** 空格分隔 scope 字符串 → 去重数组 */
export function splitScopes(scope: string): string[] {
  return [...new Set(scope.split(' ').filter((item) => item.length > 0))]
}

/** 主进程 token 中的 Web 用户 → 渲染层可见的 WebUser */
export function toWebUser(user: OAuth2WebUser | null): WebUser | null {
  if (!user || !user.id) return null
  return { id: user.id, nickname: user.nickname, avatar: user.avatar }
}

/**
 * 桌面端统一 OAuth2 授权提供者（单点授权）。
 *
 * - 所有需要 Web OAuth2 的能力（登录、专家、技能、模型等）共用一份会话 token；
 * - 本地 token 已覆盖所需 scope 时静默复用，不打开浏览器；
 * - 缺少 scope 时只请求缺失项（增量授权），用户主动关闭过的权限不会被其它入口重新申请；
 * - 从未授权过（或由历史分功能 token 迁移而来）时请求默认全量 scope，一次授权覆盖全部入口；
 * - 并发调用通过单飞锁合并，最多打开一次授权窗口。
 */
export class OAuth2AuthorizationProvider {
  private readonly oauth2Client: OAuth2ClientService
  private readonly secureStorage: ISecureStorage
  private readonly defaultScopes: readonly string[]
  /** 同一用户的并发授权请求共享同一个 Promise */
  private readonly inFlight = new Map<string, Promise<{ grantedScopes: string[] }>>()
  private readonly migrated = new Set<string>()

  constructor(deps: OAuth2AuthorizationProviderDeps) {
    this.oauth2Client = deps.oauth2Client
    this.secureStorage = deps.secureStorage
    this.defaultScopes = deps.defaultScopes ?? DESKTOP_DEFAULT_SCOPES
  }

  /** 本地已授予的 scope */
  getGrantedScopes(localUserId: string): string[] {
    this.migrateLegacyTokens(localUserId)
    const token = this.oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))
    return token ? splitScopes(token.scope) : []
  }

  /** 本地 token 中的 Web 用户（未授权返回 null） */
  getWebUser(localUserId: string): OAuth2WebUser | null {
    this.migrateLegacyTokens(localUserId)
    return this.oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))?.webUser ?? null
  }

  /** 缺失的 scope（保持入参顺序） */
  getMissingScopes(localUserId: string, required: readonly string[]): string[] {
    const granted = new Set(this.getGrantedScopes(localUserId))
    return required.filter((scope) => !granted.has(scope))
  }

  hasScopes(localUserId: string, required: readonly string[]): boolean {
    return this.getMissingScopes(localUserId, required).length === 0
  }

  getSnapshot(localUserId: string, required: readonly string[]): OAuth2AuthorizationSnapshot {
    const grantedScopes = this.getGrantedScopes(localUserId)
    const missingScopes = this.getMissingScopes(localUserId, required)
    return {
      status:
        grantedScopes.length > 0 && missingScopes.length === 0 ? 'authorized' : 'unauthorized',
      webUser: this.getWebUser(localUserId),
      grantedScopes,
      missingScopes
    }
  }

  /**
   * 确保所需 scope 已授权；必要时打开浏览器完成（增量）授权。
   * 已授权时直接返回，不产生任何用户交互。
   */
  async ensureAuthorization(
    localUserId: string,
    required: readonly string[],
    options?: EnsureAuthorizationOptions
  ): Promise<{ grantedScopes: string[] }> {
    const granted = this.getGrantedScopes(localUserId)
    const missing = required.filter((scope) => !granted.includes(scope))
    if (missing.length === 0) {
      return { grantedScopes: granted }
    }

    // 单飞：同一用户的并发请求共享同一次授权流程，只打开一个浏览器窗口
    const pending = this.inFlight.get(localUserId)
    if (pending) return pending

    const promise = this.runAuthorization(localUserId, missing, options)
    this.inFlight.set(localUserId, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(localUserId)
    }
  }

  /** 获取有效 access token（自动刷新）；scope 不足时先完成授权 */
  async ensureAccessToken(localUserId: string, required: readonly string[]): Promise<string> {
    await this.ensureAuthorization(localUserId, required)
    try {
      return await this.oauth2Client.ensureValidAccessToken(oauth2SessionTokenKey(localUserId))
    } catch (err) {
      // refresh token 已失效（例如用户在授权管理中撤销过权限）：清理后重新授权一次
      console.warn('[oauth2] refresh failed, re-authorizing:', err)
      await this.clear(localUserId)
      await this.ensureAuthorization(localUserId, required, {
        reason: 'reauth-after-refresh-failure'
      })
      return this.oauth2Client.ensureValidAccessToken(oauth2SessionTokenKey(localUserId))
    }
  }

  /**
   * 收缩本地 token 的 scope（授权管理中关闭某项权限后立即生效，决策 D3）。
   * 返回收缩后的 scope 列表。
   */
  shrinkScopes(localUserId: string, removed: readonly string[]): string[] {
    this.migrateLegacyTokens(localUserId)
    const key = oauth2SessionTokenKey(localUserId)
    const token = this.oauth2Client.loadToken(key)
    if (!token) return []
    const removedSet = new Set(removed)
    const next = splitScopes(token.scope).filter((scope) => !removedSet.has(scope))
    this.oauth2Client.saveToken(key, { ...token, scope: next.join(' ') })
    return next
  }

  /** 保存登录流程取得的 token（写入统一 key 并清理历史 key） */
  saveSessionToken(localUserId: string, token: OAuth2Token): void {
    this.oauth2Client.saveToken(oauth2SessionTokenKey(localUserId), token)
    this.secureStorage.delete(legacyPartialKey(localUserId))
    this.clearLegacyTokens(localUserId)
  }

  /** 清空本地会话 token（默认仅本地清理；决策 D1） */
  async clear(localUserId: string, options?: { revokeRemote?: boolean }): Promise<void> {
    const token = this.oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))
    if (options?.revokeRemote && token) {
      await this.oauth2Client.revoke(token.refreshToken)
    }
    this.oauth2Client.deleteToken(oauth2SessionTokenKey(localUserId))
    this.secureStorage.delete(legacyPartialKey(localUserId))
    this.clearLegacyTokens(localUserId)
  }

  /** 撤销 refresh token 并清空本地 token（登出/换绑用） */
  async revokeAndClear(localUserId: string): Promise<void> {
    await this.clear(localUserId, { revokeRemote: true })
  }

  // ── 内部实现 ──

  private async runAuthorization(
    localUserId: string,
    missing: readonly string[],
    options?: EnsureAuthorizationOptions
  ): Promise<{ grantedScopes: string[] }> {
    // 等待单飞期间可能已被其它调用补齐
    const granted = this.getGrantedScopes(localUserId)
    const stillMissing = missing.filter((scope) => !granted.includes(scope))
    if (stillMissing.length === 0) {
      return { grantedScopes: granted }
    }

    const isFirstAuthorization =
      granted.length === 0 || this.secureStorage.get(legacyPartialKey(localUserId)) === '1'
    const requestScopes = isFirstAuthorization ? [...this.defaultScopes] : stillMissing
    if (isFirstAuthorization) {
      console.info(
        '[oauth2] 首次授权，申请默认权限集合',
        options?.reason ? `(${options.reason})` : ''
      )
    }
    return this.authorizeWith(localUserId, requestScopes)
  }

  private async authorizeWith(
    localUserId: string,
    scopes: readonly string[]
  ): Promise<{ grantedScopes: string[] }> {
    const previous = this.oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))
    const token = await this.oauth2Client.authorize(scopes.join(' '))
    // 增量授权会签发新的 refresh token：撤销旧的，避免同账号多份并存
    if (previous?.refreshToken && previous.refreshToken !== token.refreshToken) {
      await this.oauth2Client.revoke(previous.refreshToken)
    }
    this.saveSessionToken(localUserId, token)
    return { grantedScopes: splitScopes(token.scope) }
  }

  private clearLegacyTokens(localUserId: string): void {
    for (const prefix of LEGACY_TOKEN_KEY_PREFIXES) {
      this.oauth2Client.deleteToken(`${prefix}${localUserId}:tokens`)
    }
  }

  /**
   * 一次性迁移：把历史分功能 token 合并进统一 key。
   * 统一 key 已存在时直接清理历史 key（新流程的 scope 以本地 token 为准）。
   */
  private migrateLegacyTokens(localUserId: string): void {
    if (this.migrated.has(localUserId)) return
    this.migrated.add(localUserId)

    const unifiedKey = oauth2SessionTokenKey(localUserId)
    if (this.oauth2Client.loadToken(unifiedKey)) {
      this.clearLegacyTokens(localUserId)
      return
    }

    let adopted: OAuth2Token | null = null
    for (const prefix of LEGACY_TOKEN_KEY_PREFIXES) {
      const legacyKey = `${prefix}${localUserId}:tokens`
      const token = this.oauth2Client.loadToken(legacyKey)
      if (!token) continue
      if (!adopted || splitScopes(token.scope).length > splitScopes(adopted.scope).length) {
        adopted = token
      }
      this.oauth2Client.deleteToken(legacyKey)
    }

    if (adopted) {
      this.oauth2Client.saveToken(unifiedKey, adopted)
      // 历史 token 只覆盖部分能力：下一次授权按「首次授权」补齐默认集合
      this.secureStorage.set(legacyPartialKey(localUserId), '1')
      console.info('[oauth2] 已迁移历史分功能 token 到统一会话')
    }
  }
}
