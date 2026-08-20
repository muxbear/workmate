/** Web 端授权用户摘要（渲染层可见） */
export interface OAuth2WebUser {
  id: string
  nickname: string
  avatar?: string
}

/** 主进程保存的 OAuth2 token（不暴露给渲染层） */
export interface OAuth2Token {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  webUser: OAuth2WebUser
}

/** 授权结果（登录关联前，token 摘要） */
export interface OAuth2AuthorizeResult {
  token: OAuth2Token
}
