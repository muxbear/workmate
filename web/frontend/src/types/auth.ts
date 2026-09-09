/** 认证 Token */
export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number // Access Token 有效期（秒），默认 7200
}

/** 角色下拉展示所需的精简信息 */
export interface RoleInfo {
  key: string
  name: string
  sortOrder: number
}

/** 用户基本信息 */
export interface UserInfo {
  id: string
  nickname: string
  avatar: string
  phone: string
  email: string
  workspaceId: string
  /** 角色 key 列表（兼容旧逻辑） */
  roles: string[]
  /** 当前人员全部角色（下拉列表数据） */
  roleList: RoleInfo[]
  /** 当前生效的角色 key */
  activeRole: string | null
}

/** 账号密码登录请求 */
export interface AccountLoginRequest {
  account: string
  password: string
  captchaTicket?: string
  captchaRandstr?: string
}

/** 手机号登录请求 */
export interface PhoneLoginRequest {
  phone: string
  smsCode: string
}

/** 注册请求 */
export interface RegisterRequest {
  phone: string
  smsCode: string
  nickname: string
  password: string
  agreedProtocolVersion: string
}

/** 发送邮箱验证码请求 */
export interface SendEmailCodeRequest {
  email: string
  captchaTicket?: string
  captchaRandstr?: string
}

/** 邮箱注册请求 */
export interface EmailRegisterRequest {
  email: string
  emailCode: string
  nickname: string
  password: string
  agreedProtocolVersion: string
}

/** 登录/注册响应 */
export interface AuthResponse {
  tokens: AuthTokens
  user: UserInfo
  needProtocolAgreement?: string
}

/** 切换角色请求 */
export interface SwitchRoleRequest {
  roleKey: string
}

/** 当前角色列表响应 */
export interface MyRolesResponse {
  roles: RoleInfo[]
  activeRole: string | null
}

/** 登录失败计数 */
export interface LoginFailInfo {
  failCount: number
  lockedUntil: number | null
}

/** 修改密码请求 */
export interface ChangePasswordRequest {
  oldPassword: string
  newPassword: string
}
