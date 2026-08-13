import { Result, LoginBody, LogoutBody, OneClickBody } from '../../common/types/Models'
import { HttpClient } from '../http/HttpClient'
import { AuthService, LoginResult } from '../contracts/AuthService'

export class RealAuthService implements AuthService {
  async login(phone: string, code: string): Promise<Result<LoginResult>> {
    const body: LoginBody = { phone, code }
    const r = await HttpClient.getInstance().post<LoginResult>('/api/v1/auth/login', body)
    if (r.ok) {
      HttpClient.getInstance().setToken(r.value.token)
    }
    return r
  }

  async oneClickLogin(providerToken: string): Promise<Result<LoginResult>> {
    const body: OneClickBody = { providerToken }
    const r = await HttpClient.getInstance().post<LoginResult>('/api/v1/auth/one-click-login', body)
    if (r.ok) {
      HttpClient.getInstance().setToken(r.value.token)
    }
    return r
  }

  async logout(): Promise<Result<void>> {
    const body: LogoutBody = {}
    await HttpClient.getInstance().post<void>('/api/v1/auth/logout', body)
    HttpClient.getInstance().clearToken()
    const ok: Result<void> = { ok: true, value: undefined as void }
    return ok
  }
}
