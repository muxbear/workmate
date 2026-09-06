import axios, { type AxiosInstance, type AxiosProgressEvent } from 'axios'
import type {
  DesktopExpert,
  DesktopMcpConfig,
  ExpertSyncProgress,
  ExpertSyncStatus,
  WebUser
} from '../../preload/index.d'
import type { ISecureStorage } from '../security/secure-storage'
import { OAuth2ClientService } from '../oauth2/OAuth2ClientService'
import { ExpertJsonStore } from './ExpertJsonStore'

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
  provider_id: string | null
  model_id: string | null
  model_name: string | null
  model_type: string | null
  tools: Array<{
    id: string
    name: string
    display_name: string
    tool_type: string
    category: string
    icon?: string
  }>
  skills: Array<{
    id: string
    name: string
    description: string
    category: string
    icon: string
    enabled: boolean
  }>
  mcp_configs: Array<{
    mcp_tool_id: string
    mcp_tool_name: string
    transport: string
    url: string
    sse_url: string
    streamable_http_url: string
    config: Record<string, unknown>
    enabled: boolean
  }>
  prompt_template: string
  expertise_areas: string[]
}

interface ExpertSyncListData {
  items: ExpertSyncItem[]
  total: number
  synced_at: number
}

interface ExpertSyncServiceDeps {
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  /** ~/.ke-work/experts 目录（由主进程 DataDirectory 解析后注入） */
  expertsDir: string
  apiBaseUrl?: string
  clientId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const TOKEN_KEY_PREFIX = 'expert-sync:'
const EXPERT_SCOPE = 'expert:read'
const JSON_FILE_VERSION = 1

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
    tools: item.tools.map((tool) => tool.name),
    skills: item.skills,
    providerId: item.provider_id,
    modelId: item.model_id,
    modelName: item.model_name,
    modelType: item.model_type,
    mcpConfigs: item.mcp_configs.map((cfg): DesktopMcpConfig => ({
      mcpToolId: cfg.mcp_tool_id,
      mcpToolName: cfg.mcp_tool_name,
      transport: cfg.transport,
      url: cfg.url,
      sseUrl: cfg.sse_url,
      streamableHttpUrl: cfg.streamable_http_url,
      config: cfg.config,
      enabled: cfg.enabled
    })),
    promptTemplate: item.prompt_template,
    expertiseAreas: item.expertise_areas,
    isExpert: true
  }
}

/**
 * 桌面版 Web 专家同步服务。
 *
 * 职责：OAuth2 Authorization Code + PKCE 授权、expert:read scope 拉取专家列表，
 * 映射后原子写入 ~/.ke-work/experts/experts.json，并以文件读回结果作为同步返回值，
 * 保证页面展示的数据与磁盘一致。
 */
export class ExpertSyncService {
  private readonly http: AxiosInstance
  private readonly apiBaseUrl: string
  private readonly clientId: string
  private readonly oauth2: OAuth2ClientService
  private readonly store: ExpertJsonStore
  private cachedExperts: DesktopExpert[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: ExpertSyncServiceDeps) {
    this.apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.store = new ExpertJsonStore(deps.expertsDir)
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

  /**
   * 拉取专家列表 → 映射 → 写盘 → 读回校验。
   * 同步期间通过 onProgress 回调向调用方（IPC → 渲染层）推送阶段进度。
   */
  async sync(
    localUserId: string,
    onProgress?: (p: ExpertSyncProgress) => void
  ): Promise<{ experts: DesktopExpert[]; syncedAt: number }> {
    this.report(onProgress, 'authorize', 5, '正在校验专家同步授权…')
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const webUser = this.getStatus(localUserId).webUser

    this.report(onProgress, 'fetch', 12, '正在从服务器拉取专家数据…')
    const data = await this.request<ExpertSyncListData>('get', '/api/expert-sync/list', undefined, {
      headers: { Authorization: `Bearer ${accessToken}` },
      onDownloadProgress: (e: AxiosProgressEvent): void => {
        if (!e.total) return
        const ratio = Math.min(Math.max(e.loaded / e.total, 0), 1)
        this.report(onProgress, 'fetch', Math.round(12 + ratio * 55), '正在从服务器拉取专家数据…')
      }
    })

    const mapped = data.items.map(mapExpert)
    const syncedAt = Date.now()
    this.report(onProgress, 'save', 75, '正在保存专家数据到本地…')
    await this.store.write({
      version: JSON_FILE_VERSION,
      syncedAt,
      syncedBy: webUser ? { webUserId: webUser.id || '', nickname: webUser.nickname || '' } : null,
      experts: mapped
    })

    this.report(onProgress, 'load', 88, '正在加载本地专家数据…')
    const disk = await this.store.read()
    this.cachedExperts = disk?.experts ?? mapped
    this.lastSyncedAt = disk?.syncedAt ?? syncedAt
    this.report(onProgress, 'done', 100, '专家数据同步完成')
    return { experts: this.cachedExperts, syncedAt: this.lastSyncedAt }
  }

  /** 读取 ~/.ke-work/experts/experts.json 供页面展示；文件缺失返回 null。 */
  async loadLocal(): Promise<{ experts: DesktopExpert[]; syncedAt: number } | null> {
    const data = await this.store.read()
    if (!data) return null
    this.cachedExperts = data.experts
    this.lastSyncedAt = data.syncedAt
    return { experts: data.experts, syncedAt: data.syncedAt }
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

  private report(
    onProgress: ((p: ExpertSyncProgress) => void) | undefined,
    phase: ExpertSyncProgress['phase'],
    percent: number,
    message: string
  ): void {
    onProgress?.({ phase, percent, message })
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
