import { http } from '@kit.NetworkKit'
import { Constants } from '../../common/constants/Constants'
import { ApiResponse, Result } from '../../common/types/Models'

/** 统一 HTTP 客户端:Token 注入、超时、ApiResponse 解包 */
export class HttpClient {
  private static instance: HttpClient | null = null
  private token: string = ''

  static getInstance(): HttpClient {
    if (!HttpClient.instance) {
      HttpClient.instance = new HttpClient()
    }
    return HttpClient.instance
  }

  setToken(token: string): void {
    this.token = token
  }

  clearToken(): void {
    this.token = ''
  }

  async get<T>(url: string): Promise<Result<T>> {
    return this.request<T>('GET', url, undefined)
  }

  async post<T>(url: string, body: object): Promise<Result<T>> {
    return this.request<T>('POST', url, body)
  }

  private async request<T>(method: 'GET' | 'POST', url: string, body?: object): Promise<Result<T>> {
    const req = http.createHttp()
    try {
      const header: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.token) {
        header['Authorization'] = `Bearer ${this.token}`
      }
      const resp = await req.request(Constants.BASE_URL + url, {
        method: method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: header,
        extraData: body ? JSON.stringify(body) : undefined,
        connectTimeout: Constants.TIMEOUT_MS,
        readTimeout: Constants.TIMEOUT_MS,
      })
      const apiResp = JSON.parse(resp.result as string) as ApiResponse<T>
      if (apiResp.code === 0 && apiResp.data !== null) {
        return { ok: true, value: apiResp.data } as Result<T>
      }
      if (apiResp.code === 401) {
        this.clearToken()
        return { ok: false, code: 401, message: '登录已过期,请重新登录' } as Result<T>
      }
      return { ok: false, code: apiResp.code, message: apiResp.message } as Result<T>
    } catch (e) {
      return { ok: false, code: -1, message: '网络异常,请稍后重试' } as Result<T>
    } finally {
      req.destroy()
    }
  }
}
