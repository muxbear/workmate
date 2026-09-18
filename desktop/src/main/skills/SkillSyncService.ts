import axios, { type AxiosInstance } from 'axios'
import type { DesktopSkill, SkillSyncStatus, WebUser } from '../../preload/index.d'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_SKILL_READ } from '../oauth2/scopes'

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
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  apiBaseUrl?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'

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
 * 复用统一 OAuth2 授权提供者（skill:read scope）：已授权时静默使用会话 token，
 * 缺少 scope 时才触发（增量）授权；token 不暴露给渲染层。
 */
export class SkillSyncService {
  private readonly http: AxiosInstance
  private readonly authorization: OAuth2AuthorizationProvider
  private cachedSkills: DesktopSkill[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: SkillSyncServiceDeps) {
    const apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.authorization = deps.authorization
    this.http = axios.create({
      baseURL: apiBaseUrl,
      timeout: 15_000
    })
  }

  getStatus(localUserId: string): SkillSyncStatus {
    const snapshot = this.authorization.getSnapshot(localUserId, [SCOPE_SKILL_READ])
    return {
      status: snapshot.status,
      webUser: toWebUser(snapshot.webUser)
    }
  }

  /** 确保 skill:read 已授权；已授权时不打开浏览器 */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    await this.authorization.ensureAuthorization(localUserId, [SCOPE_SKILL_READ], {
      reason: 'skill-sync'
    })
    return { webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  async sync(localUserId: string): Promise<{ skills: DesktopSkill[]; syncedAt: number }> {
    const accessToken = await this.authorization.ensureAccessToken(localUserId, [SCOPE_SKILL_READ])
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

  /** 断开同步：仅清理本地缓存与本地会话 token（决策 D1） */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
    this.cachedSkills = []
    this.lastSyncedAt = null
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
