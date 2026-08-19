import { createHash, randomBytes } from 'crypto'
import axios, { type AxiosInstance } from 'axios'
import type { DesktopSkill, SkillSyncStatus, WebUser } from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import { DesktopOAuthCallbackServer } from './DesktopOAuthCallbackServer'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

interface AuthorizationUrlData {
  authorizeUrl: string
  state: string
}

interface OAuth2TokenData {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
  user: WebUser
}

interface RefreshTokenData {
  tokens: {
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
  user?: WebUser
}

interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  webUserId: string
  webNickname: string
  webAvatar?: string
}

interface WebSkillInfo {
  id: string
  name: string
  description: string
  category: string
  icon: string
  enabled: boolean
  is_builtin: boolean
  source: string
}

interface SkillListData {
  items: WebSkillInfo[]
  total: number
  page: number
  page_size: number
}

interface SkillSyncServiceDeps {
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  apiBaseUrl?: string
  clientId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const TOKEN_KEY_PREFIX = 'skill-sync:'

function base64Url(input: Buffer): string {
  return input.toString('base64url')
}

function colorForCategory(category: string): string {
  const colors: Record<string, string> = {
    custom: 'linear-gradient(135deg,#0891b2,#0e7490)',
    code: 'linear-gradient(135deg,#f97316,#ea580c)',
    network: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    data: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
    message: 'linear-gradient(135deg,#10b981,#059669)',
    file: 'linear-gradient(135deg,#06b6d4,#0891b2)',
    ai: 'linear-gradient(135deg,#ec4899,#db2777)',
    system: 'linear-gradient(135deg,#475569,#334155)'
  }
  return colors[category] ?? colors.custom!
}

function mapSkill(item: WebSkillInfo): DesktopSkill {
  return {
    id: item.id,
    name: item.name,
    desc: item.description,
    category: item.category,
    icon: item.icon || 'Zap',
    color: colorForCategory(item.category),
    enabled: item.enabled,
    isBuiltin: item.is_builtin,
    source: item.source
  }
}

/**
 * 桌面端 Web 技能同步服务。
 *
 * 负责 OAuth2 Authorization Code + PKCE、loopback 回调、token 安全存储、
 * access token 刷新和技能列表同步。token 不暴露给渲染层。
 */
export class SkillSyncService {
  private readonly http: AxiosInstance
  private readonly apiBaseUrl: string
  private readonly clientId: string
  private cachedSkills: DesktopSkill[] = []
  private lastSyncedAt: number | null = null

  constructor(private readonly deps: SkillSyncServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.http = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 15_000
    })
  }

  getStatus(localUserId: string): SkillSyncStatus {
    const token = this.loadToken(localUserId)
    if (!token?.accessToken) {
      return { status: 'unauthorized', webUser: null }
    }
    return {
      status: 'authorized',
      webUser: {
        id: token.webUserId,
        nickname: token.webNickname,
        avatar: token.webAvatar
      }
    }
  }

  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    const verifier = base64Url(randomBytes(48))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const callbackServer = new DesktopOAuthCallbackServer()

    try {
      await callbackServer.start()
      const redirectUri = callbackServer.getRedirectUri()
      const authData = await this.request<AuthorizationUrlData>(
        'post',
        '/api/oauth2/authorization-url',
        {
          client_id: this.clientId,
          redirect_uri: redirectUri,
          scope: 'skill:read',
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }
      )

      callbackServer.setExpectedState(authData.state)
      await this.deps.openExternal(authData.authorizeUrl)
      const callback = await callbackServer.waitForCallback()
      if (callback.error) {
        throw new Error(callback.error === 'access_denied' ? '已取消授权' : callback.error)
      }
      if (!callback.code) {
        throw new Error('未收到授权码')
      }

      const token = await this.request<OAuth2TokenData>('post', '/api/oauth2/token', {
        grant_type: 'authorization_code',
        client_id: this.clientId,
        redirect_uri: redirectUri,
        code: callback.code,
        code_verifier: verifier
      })

      this.saveToken(localUserId, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: Date.now() + token.expiresIn * 1000,
        webUserId: token.user.id,
        webNickname: token.user.nickname,
        webAvatar: token.user.avatar
      })

      return { webUser: token.user }
    } finally {
      await callbackServer.stop()
    }
  }

  async sync(localUserId: string): Promise<{ skills: DesktopSkill[]; syncedAt: number }> {
    const token = await this.ensureValidAccessToken(localUserId)
    const data = await this.request<SkillListData>('get', '/api/skill/list', undefined, {
      params: { page: 1, page_size: 100 },
      headers: { Authorization: `Bearer ${token}` }
    })

    this.cachedSkills = data.items.map(mapSkill)
    this.lastSyncedAt = Date.now()
    return { skills: this.cachedSkills, syncedAt: this.lastSyncedAt }
  }

  getCachedSkills(): DesktopSkill[] {
    return this.cachedSkills
  }

  async disconnect(localUserId: string): Promise<void> {
    this.deps.secureStorage.delete(this.tokenKey(localUserId))
    this.cachedSkills = []
    this.lastSyncedAt = null
  }

  private tokenKey(localUserId: string): string {
    return `${TOKEN_KEY_PREFIX}${localUserId}:tokens`
  }

  private loadToken(localUserId: string): StoredToken | null {
    const raw = this.deps.secureStorage.get(this.tokenKey(localUserId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredToken
    } catch {
      return null
    }
  }

  private saveToken(localUserId: string, token: StoredToken): void {
    this.deps.secureStorage.set(this.tokenKey(localUserId), JSON.stringify(token))
  }

  private async ensureValidAccessToken(localUserId: string): Promise<string> {
    const token = this.loadToken(localUserId)
    if (!token) {
      throw new Error('尚未授权，请先同步技能')
    }
    if (token.expiresAt > Date.now() + 30_000) {
      return token.accessToken
    }

    const data = await this.request<RefreshTokenData>(
      'post',
      '/api/auth/refresh',
      { refreshToken: token.refreshToken }
    )
    const next: StoredToken = {
      ...token,
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
      expiresAt: Date.now() + data.tokens.expiresIn * 1000,
      webUserId: data.user?.id ?? token.webUserId,
      webNickname: data.user?.nickname ?? token.webNickname,
      webAvatar: data.user?.avatar ?? token.webAvatar
    }
    this.saveToken(localUserId, next)
    return next.accessToken
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    config?: Record<string, unknown>
  ): Promise<T> {
    try {
      const response =
        method === 'post'
          ? await this.http.post<WebApiEnvelope<T>>(path, body, config)
          : await this.http.get<WebApiEnvelope<T>>(path, config)
      const envelope = response.data
      if (envelope.code !== 0) {
        throw new Error(envelope.message || 'Web 服务返回错误')
      }
      return envelope.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || error.message || '网络请求失败'
        throw new Error(message)
      }
      throw error
    }
  }
}
