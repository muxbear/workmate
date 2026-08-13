import { Result, UserProfile } from '../../common/types/Models'

export interface LoginResult {
  token: string
  profile: UserProfile
}

/** 认证服务契约:登录/一键登录/登出 */
export interface AuthService {
  /** 手机号 + 验证码登录(验证码 SDK 接入后启用) */
  login(phone: string, code: string): Promise<Result<LoginResult>>
  /** 本机号码一键登录:providerToken 由移动认证 SDK 换取后传入 */
  oneClickLogin(providerToken: string): Promise<Result<LoginResult>>
  logout(): Promise<Result<void>>
}
