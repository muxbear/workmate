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

  /**
   * 使用授权码兑换 token。
   * 注：/api/oauth2/token 返回 RFC 6749 §5.1 标准 JSON（非 envelope），
   * 桌面端主进程直连调用；Web 前端一般不在浏览器中兑换。
   */
  exchangeToken: (data: TokenRequest) =>
    request.post<TokenResponse>('/oauth2/token', data),
}
