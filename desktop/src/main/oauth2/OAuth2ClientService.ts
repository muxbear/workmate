import { createHash, randomBytes } from 'crypto'
import axios, { type AxiosInstance } from 'axios'
import type { ISecureStorage } from '../security/secure-storage'
import { DesktopOAuthCallbackServer } from './DesktopOAuthCallbackServer'
import type { OAuth2Token, OAuth2WebUser } from './types'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

interface AuthorizationUrlData {
  authorizeUrl: string
  state: string
}

interface TokenResponseData {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
  user: OAuth2WebUser
}

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  webUser: OAuth2WebUser
}

export interface OAuth2ClientServiceDeps {
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  apiBaseUrl?: string
  clientId?: string
  /** HTTP 客户端（测试注入 mock 适配器用） */
  http?: AxiosInstance
  /** 回调服务器工厂（测试注入 fake；默认真实 loopback 服务器） */
  callbackServerFactory?: () => DesktopOAuthCallbackServer
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const REFRESH_MARGIN_MS = 30_000

function base64Url(input: Buffer): string {
  return input.toString('base64url')
}

/**
 * 桌面端 OAuth2 客户端服务（Authorization Code + PKCE）。
 *
 * 职责：PKCE 生成、loopback 回调、换取/刷新/撤销 token、token 安全存储。
 * 支持登录前调用（不依赖本地用户）；token 不暴露给渲染层。
 */
export class OAuth2ClientService {
  private readonly http: AxiosInstance
  private readonly apiBaseUrl: string
  private readonly clientId: string
  /** 刷新单飞：同一存储 key 并发刷新共享一次请求 */
  private readonly refreshPromises = new Map<string, Promise<OAuth2Token>>()

  constructor(private readonly deps: OAuth2ClientServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.http =
      deps.http ??
      axios.create({
        baseURL: this.apiBaseUrl,
        timeout: 15_000
      })
  }

  /** 执行完整授权流程（浏览器授权 → 回跳 → 换 token），返回 token */
  async authorize(scope: string): Promise<OAuth2Token> {
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const callbackServer = this.deps.callbackServerFactory
      ? this.deps.callbackServerFactory()
      : new DesktopOAuthCallbackServer()

    try {
      await callbackServer.start()
      const redirectUri = callbackServer.getRedirectUri()
      const authData = await this.requestEnvelope<AuthorizationUrlData>(
        '/api/oauth2/authorization-url',
        {
          client_id: this.clientId,
          redirect_uri: redirectUri,
          scope,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }
      )

      callbackServer.setExpectedState(authData.state)
      await this.deps.openExternal(authData.authorizeUrl)
      const callback = await callbackServer.waitForCallback()
      if (callback.error) {
        throw new Error(
          callback.error === 'access_denied' ? '已取消授权' : callback.error
        )
      }
      if (!callback.code) {
        throw new Error('未收到授权码')
      }

      const data = await this.requestRaw<TokenResponseData>('/api/oauth2/token', {
        grant_type: 'authorization_code',
        client_id: this.clientId,
        redirect_uri: redirectUri,
        code: callback.code,
        code_verifier: verifier
      })
      return this.toToken(data)
    } finally {
      await callbackServer.stop()
    }
  }

  /** 刷新 access token（refresh token 轮换） */
  async refresh(refreshToken: string): Promise<OAuth2Token> {
    const data = await this.requestRaw<TokenResponseData>('/api/oauth2/refresh', {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken
    })
    return this.toToken(data)
  }

  /** 撤销 refresh token（RFC 7009）；失败不抛错，不阻断本地清理 */
  async revoke(refreshToken: string): Promise<void> {
    try {
      await this.requestRaw('/api/oauth2/revoke', {
        token: refreshToken,
        token_type_hint: 'refresh_token'
      })
    } catch {
      // 撤销失败时服务端 token 会自然过期，本地仍按登出处理
    }
  }

  // ── token 存取 ──

  saveToken(key: string, token: OAuth2Token): void {
    this.deps.secureStorage.set(key, JSON.stringify(this.toStored(token)))
  }

  loadToken(key: string): OAuth2Token | null {
    const raw = this.deps.secureStorage.get(key)
    if (!raw) return null
    try {
      const stored = JSON.parse(raw) as StoredToken
      return {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        scope: stored.scope ?? '',
        webUser: stored.webUser ?? {
          id: '',
          nickname: ''
        }
      }
    } catch {
      return null
    }
  }

  deleteToken(key: string): void {
    this.deps.secureStorage.delete(key)
  }

  getStatus(key: string): {
    status: 'authorized' | 'unauthorized'
    webUser: OAuth2WebUser | null
  } {
    const token = this.loadToken(key)
    if (!token?.accessToken) {
      return { status: 'unauthorized', webUser: null }
    }
    return { status: 'authorized', webUser: token.webUser }
  }

  /** 返回有效 access token；临近过期或已过期时自动刷新（单飞） */
  async ensureValidAccessToken(key: string): Promise<string> {
    const token = this.loadToken(key)
    if (!token?.accessToken) {
      throw new Error('尚未授权，请先登录 Web 账号')
    }
    if (token.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
      return token.accessToken
    }

    const pending = this.refreshPromises.get(key)
    if (pending) {
      return pending.then((next) => next.accessToken)
    }

    const promise = this.refresh(token.refreshToken)
      .then((next) => {
        this.saveToken(key, next)
        return next
      })
      .finally(() => {
        this.refreshPromises.delete(key)
      })
    this.refreshPromises.set(key, promise)
    return promise.then((next) => next.accessToken)
  }

  // ── 内部工具 ──

  private toToken(data: TokenResponseData): OAuth2Token {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
      webUser: data.user
    }
  }

  private toStored(token: OAuth2Token): StoredToken {
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scope: token.scope,
      webUser: token.webUser
    }
  }

  private async requestEnvelope<T>(
    path: string,
    body: unknown
  ): Promise<T> {
    try {
      const response = await this.http.post<WebApiEnvelope<T>>(path, body)
      const envelope = response.data
      if (envelope.code !== 0) {
        throw new Error(envelope.message || 'Web 服务返回错误')
      }
      return envelope.data
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  private async requestRaw<T>(
    path: string,
    body: unknown
  ): Promise<T> {
    try {
      const response = await this.http.post<T>(path, body)
      return response.data
    } catch (error) {
      throw this.normalizeError(error)
    }
  }

  private normalizeError(error: unknown): Error {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        | { error?: string; error_description?: string; message?: string }
        | undefined
      const message =
        data?.error_description ||
        data?.error ||
        data?.message ||
        error.message ||
        '网络请求失败'
      return new Error(message)
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}
