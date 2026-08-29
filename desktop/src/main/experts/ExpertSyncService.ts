import axios, { type AxiosInstance } from 'axios'
import type { DesktopExpert, ExpertSyncStatus, WebUser } from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import { OAuth2ClientService } from '../oauth2/OAuth2ClientService'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

interface ExpertSyncItem {
  id: string
  name: string
  title: string
  desc: string
  category: string
  tags: string[]
  color: string
  initials: string
  icon: string
  avatar_url: string | null
  rating: number
  users: string
  system_prompt: string
  scene: string | null
  sort_order: number
}

interface ExpertSyncListData {
  items: ExpertSyncItem[]
  total: number
  synced_at: number
}

interface ExpertSyncServiceDeps {
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  apiBaseUrl?: string
  clientId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const TOKEN_KEY_PREFIX = 'expert-sync:'
const EXPERT_SCOPE = 'expert:read'

function mapExpert(item: ExpertSyncItem): DesktopExpert {
  return {
    id: item.id,
    name: item.name,
    title: item.title || item.desc,
    tags: item.tags,
    desc: item.desc,
    color: item.color || 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: item.icon || 'Zap',
    category: item.category,
    rating: item.rating,
    users: item.users,
    initials: item.initials || item.name.charAt(0),
    systemPrompt: item.system_prompt,
    tools: [],
    providerId: null,
    modelId: null,
    promptTemplate: '',
    expertiseAreas: [],
    isExpert: true
  }
}

/**
 * 桌面端 Web 专家同步服务。
 *
 * 复用 SkillSyncService 的 OAuth2 Authorization Code + PKCE 流程，
 * 使用独立的 expert:read scope 调用 /api/expert-sync/list。
 */
export class ExpertSyncService {
  private readonly http: AxiosInstance
  private readonly apiBaseUrl: string
  private readonly clientId: string
  private readonly oauth2: OAuth2ClientService
  private cachedExperts: DesktopExpert[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: ExpertSyncServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.oauth2 = new OAuth2ClientService({
      secureStorage: deps.secureStorage,
      openExternal: deps.openExternal,
      apiBaseUrl: this.apiBaseUrl,
      clientId: this.clientId
    })
    this.http = axios.create({ baseURL: this.apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): ExpertSyncStatus {
    const status = this.oauth2.getStatus(this.tokenKey(localUserId))
    if (status.status !== 'authorized') {
      return { status: 'unauthorized', webUser: null }
    }
    return {
      status: 'authorized',
      webUser: {
        id: status.webUser?.id ?? '',
        nickname: status.webUser?.nickname ?? '',
        avatar: status.webUser?.avatar
      }
    }
  }

  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    const token = await this.oauth2.authorize(EXPERT_SCOPE)
    this.oauth2.saveToken(this.tokenKey(localUserId), token)
    return { webUser: token.webUser }
  }

  async sync(localUserId: string): Promise<{ experts: DesktopExpert[]; syncedAt: number }> {
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const data = await this.request<ExpertSyncListData>('get', '/api/expert-sync/list', undefined, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    this.cachedExperts = data.items.map(mapExpert)
    this.lastSyncedAt = Date.now()
    return { experts: this.cachedExperts, syncedAt: this.lastSyncedAt }
  }

  getCachedExperts(): DesktopExpert[] {
    return this.cachedExperts
  }

  async disconnect(localUserId: string): Promise<void> {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    if (token) {
      await this.oauth2.revoke(token.refreshToken)
    }
    this.oauth2.deleteToken(this.tokenKey(localUserId))
    this.cachedExperts = []
    this.lastSyncedAt = null
  }

  private tokenKey(localUserId: string): string {
    return `${TOKEN_KEY_PREFIX}${localUserId}:tokens`
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
