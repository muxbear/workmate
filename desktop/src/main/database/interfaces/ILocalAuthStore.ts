import type { WorkMode } from '../../mode/work-mode'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  mobile?: string
  wechatOpenid?: string
  avatar?: string
  workMode: WorkMode
  createdAt: number
  updatedAt: number
  failedLoginAttempts: number
  lockedUntil: number | null
  tokenHash: string | null
  tokenExpire: number | null
  /** 绑定的 Web 账号 id（OAuth2 登录后写入，1:1） */
  webAccountId?: string
  webNickname?: string
  webAvatar?: string
  webLinkedAt?: number
  /** web-only 用户禁止走密码/验证码登录 */
  isWebOnly: boolean
}

export interface SmsCodeRecord {
  mobile: string
  codeHash: string
  expiresAt: number
  used: boolean
  createdAt: number
}

export interface AuditLogInput {
  userId?: string
  action: string
  detail?: string
  ipAddress?: string
}

/** oauth2_sessions 会话索引记录（token 权威在 secureStorage） */
export interface OAuth2SessionRecord {
  id: string
  localUserId: string
  webAccountId: string
  scope: string
  expiresAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 本地认证存储原语（users / sms_codes / audit_logs / oauth2_sessions 表）。
 *
 * ISP 拆分（R8-2）：本接口只描述**本地存储**，唯一实现是 `LocalAuthRepository`。
 * 旧的「本地 SQLite / 云端 API 共用」契约已废除 —— 云端 HTTP 登录面
 * （原 CloudAuthRepository 的 login-by-password/sms/wechat/refresh）在生产链路
 * 零调用（桌面端登录凭据始终校验本地 users 表，Web 身份经 OAuth2 关联，
 * 见 oauth2/OAuth2ClientService 与 services/AuthService.loginByOAuth2），
 * 已连同 13 个 no-op 适配方法一并删除，杜绝「cloud 实现被注入给期待真实存储的服务」
 * 类缺陷（历史上的 D3：cloud 模式密码登录必然失败）。
 */
export interface ILocalAuthStore {
  /** 按账号（username 或 mobile）查找用户 */
  findByAccount(account: string): Promise<UserRecord | null>
  /** 按用户 id 查找 */
  findById(userId: string): Promise<UserRecord | null>
  findByMobile(mobile: string): Promise<UserRecord | null>
  findByWechatOpenid(openid: string): Promise<UserRecord | null>
  /** 按 Web 账号 id 查找已绑定用户（无绑定返回 null） */
  findByWebAccountId(webAccountId: string): Promise<UserRecord | null>
  createUser(input: {
    username: string
    passwordHash?: string
    mobile?: string
    wechatOpenid?: string
  }): Promise<UserRecord>
  /** 创建 web-only 本地用户（随机口令不可登录，绑定 Web 账号） */
  createWebOnlyUser(input: {
    webAccountId: string
    webNickname?: string
    webAvatar?: string
  }): Promise<UserRecord>
  /** 建立/更新本地用户与 Web 账号的绑定（1:1） */
  linkWebAccount(input: {
    userId: string
    webAccountId: string
    webNickname?: string
    webAvatar?: string
  }): Promise<void>
  /** 解除本地用户与 Web 账号的绑定（换绑/解绑时调用） */
  unlinkWebAccount(userId: string): Promise<void>
  /** 读取本地用户的 OAuth2 会话索引 */
  getOAuth2Session(localUserId: string): Promise<OAuth2SessionRecord | null>
  /** 写入/更新本地用户的 OAuth2 会话索引 */
  saveOAuth2Session(input: {
    localUserId: string
    webAccountId: string
    scope: string
    expiresAt: number | null
  }): Promise<void>
  /** 清理本地用户的 OAuth2 会话索引 */
  clearOAuth2Session(localUserId: string): Promise<void>
  /**
   * 记录登录失败，返回最新计数与锁定时间
   * @param now 当前时间（由调用方注入，保证时钟可测）
   */
  recordLoginFailure(
    userId: string,
    maxAttempts: number,
    lockDurationMs: number,
    now: number
  ): Promise<{ attempts: number; lockedUntil: number | null }>
  resetLoginFailures(userId: string): Promise<void>
  updateToken(userId: string, tokenHash: string | null, expireAt: number | null): Promise<void>
  saveSmsCode(mobile: string, codeHash: string, expiresAt: number): Promise<void>
  findSmsCode(mobile: string): Promise<SmsCodeRecord | null>
  markSmsCodeUsed(mobile: string): Promise<void>
  addAuditLog(input: AuditLogInput): Promise<void>
}
