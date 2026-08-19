import request from './request'
import type { ApiResponse } from '@/types/api'
import type {
  AuthorizationUrlRequest,
  AuthorizeContextResponse,
  TokenRequest,
  TokenResponse,
} from '@/types/oauth2'

export const oauth2Api = {
  /** 创建授权请求，返回授权页 URL */
  createAuthorizationUrl: (data: AuthorizationUrlRequest) =>
    request.post<
      ApiResponse<{ authorizeUrl: string; state: string }>
    >('/oauth2/authorization-url', data),

  /** 获取授权页上下文 */
  getAuthorizeContext: (state: string) =>
    request.get<ApiResponse<AuthorizeContextResponse>>(
      '/oauth2/authorize/context',
      { params: { state } },
    ),

  /** 确认授权 */
  approve: (state: string) =>
    request.post<ApiResponse<{ redirectUrl: string }>>(
      '/oauth2/authorize/approve',
      { state },
    ),

  /** 使用授权码兑换 token */
  exchangeToken: (data: TokenRequest) =>
    request.post<ApiResponse<TokenResponse>>('/oauth2/token', data),
}
