/** OAuth2 客户端授权相关类型 */

export interface AuthorizationUrlRequest {
  client_id: string
  redirect_uri: string
  scope: string
  code_challenge: string
  code_challenge_method: 'S256'
}

export interface OAuth2ClientInfo {
  client_id: string
  client_name: string
}

export interface OAuth2ScopeInfo {
  key: string
  label: string
}

export interface OAuth2UserInfo {
  id: string
  nickname: string
  avatar: string
}

export interface AuthorizeContextResponse {
  state: string
  redirectUri: string
  client: OAuth2ClientInfo
  scopes: OAuth2ScopeInfo[]
  user: OAuth2UserInfo
}

export interface TokenRequest {
  grant_type: 'authorization_code'
  client_id: string
  redirect_uri: string
  code: string
  code_verifier: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
  user: OAuth2UserInfo
}
