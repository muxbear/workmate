/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function */
import type { CloudDataSource } from './CloudDataSource'
import type {
  AuditLogInput,
  IAuthRepository,
  OAuth2SessionRecord,
  SmsCodeRecord,
  UserRecord
} from '../interfaces/IAuthRepository'

export interface CloudUser {
  id: string
  username: string
  mobile?: string
}

export interface LoginResponse {
  token: string
  refreshToken: string
  user: CloudUser
}

/**
 * 云端认证实现（HTTP 适配）
 * 用户状态（失败计数/锁定/token 哈希）由服务端管理，本地 no-op
 */
export class CloudAuthRepository implements IAuthRepository {
  constructor(private readonly ds: CloudDataSource) {}

  loginByPassword(account: string, password: string): Promise<LoginResponse> {
    return this.ds.post<LoginResponse>('/api/auth/login-password', { account, password })
  }

  loginBySms(mobile: string, code: string): Promise<LoginResponse> {
    return this.ds.post<LoginResponse>('/api/auth/login-sms', { mobile, code })
  }

  loginByWechat(code: string): Promise<LoginResponse> {
    return this.ds.post<LoginResponse>('/api/auth/login-wechat', { code })
  }

  async sendSmsCode(mobile: string): Promise<void> {
    await this.ds.post('/api/auth/send-code', { mobile })
  }

  refreshToken(refreshToken: string): Promise<{ token: string; refreshToken: string }> {
    return this.ds.post<{ token: string; refreshToken: string }>('/api/auth/refresh', {
      refreshToken
    })
  }

  async logout(): Promise<void> {
    await this.ds.post('/api/auth/logout')
  }

  // ── 服务端管理的状态：本地 no-op ──

  findByAccount(_account: string): Promise<UserRecord | null> {
    return Promise.resolve(null)
  }
  findById(_userId: string): Promise<UserRecord | null> {
    return Promise.resolve(null)
  }
  findByMobile(_mobile: string): Promise<UserRecord | null> {
    return Promise.resolve(null)
  }
  findByWechatOpenid(_openid: string): Promise<UserRecord | null> {
    return Promise.resolve(null)
  }
  findByWebAccountId(_webAccountId: string): Promise<UserRecord | null> {
    return Promise.resolve(null)
  }
  async createUser(_input: {
    username: string
    passwordHash?: string
    mobile?: string
    wechatOpenid?: string
  }): Promise<UserRecord> {
    throw new Error('cloud users are managed by server')
  }
  async createWebOnlyUser(_input: {
    webAccountId: string
    webNickname?: string
    webAvatar?: string
  }): Promise<UserRecord> {
    throw new Error('cloud users are managed by server')
  }
  async linkWebAccount(_input: {
    userId: string
    webAccountId: string
    webNickname?: string
    webAvatar?: string
  }): Promise<void> {}
  async unlinkWebAccount(_userId: string): Promise<void> {}
  async getOAuth2Session(_localUserId: string): Promise<OAuth2SessionRecord | null> {
    return null
  }
  async saveOAuth2Session(_input: {
    localUserId: string
    webAccountId: string
    scope: string
    expiresAt: number | null
  }): Promise<void> {}
  async clearOAuth2Session(_localUserId: string): Promise<void> {}
  async recordLoginFailure(
    _userId: string,
    _maxAttempts: number,
    _lockDurationMs: number,
    _now: number
  ): Promise<{ attempts: number; lockedUntil: number | null }> {
    return { attempts: 0, lockedUntil: null }
  }
  async resetLoginFailures(_userId: string): Promise<void> {}
  async updateToken(_userId: string, _tokenHash: string | null, _expireAt: number | null): Promise<void> {}
  async saveSmsCode(_mobile: string, _codeHash: string, _expiresAt: number): Promise<void> {}
  async findSmsCode(_mobile: string): Promise<SmsCodeRecord | null> {
    return null
  }
  async markSmsCodeUsed(_mobile: string): Promise<void> {}
  async addAuditLog(_input: AuditLogInput): Promise<void> {}
}
