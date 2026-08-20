import axios, { type AxiosInstance } from 'axios'
import type { DesktopSkill, SkillSyncStatus, WebUser } from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import { OAuth2ClientService } from '../oauth2/OAuth2ClientService'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
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
  private readonly oauth2: OAuth2ClientService
  private cachedSkills: DesktopSkill[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: SkillSyncServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.oauth2 = new OAuth2ClientService({
      secureStorage: deps.secureStorage,
      openExternal: deps.openExternal,
      apiBaseUrl: this.apiBaseUrl,
      clientId: this.clientId
    })
    this.http = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 15_000
    })
  }

  getStatus(localUserId: string): SkillSyncStatus {
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
    const token = await this.oauth2.authorize('skill:read')
    this.oauth2.saveToken(this.tokenKey(localUserId), token)
    return { webUser: token.webUser }
  }

  async sync(localUserId: string): Promise<{ skills: DesktopSkill[]; syncedAt: number }> {
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const data = await this.request<SkillListData>('get', '/api/skill/list', undefined, {
      params: { page: 1, page_size: 100 },
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    this.cachedSkills = data.items.map(mapSkill)
    this.lastSyncedAt = Date.now()
    return { skills: this.cachedSkills, syncedAt: this.lastSyncedAt }
  }

  getCachedSkills(): DesktopSkill[] {
    return this.cachedSkills
  }

  async disconnect(localUserId: string): Promise<void> {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    if (token) {
      await this.oauth2.revoke(token.refreshToken)
    }
    this.oauth2.deleteToken(this.tokenKey(localUserId))
    this.cachedSkills = []
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
