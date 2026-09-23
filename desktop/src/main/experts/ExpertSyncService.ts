import axios, { type AxiosInstance, type AxiosProgressEvent } from 'axios'
import type {
  DesktopExpert,
  DesktopMcpConfig,
  ExpertSyncProgress,
  ExpertSyncStats,
  ExpertSyncStatus,
  WebUser
} from '../../preload/index.d'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_EXPERT_READ } from '../oauth2/scopes'
import { ExpertJsonStore } from './ExpertJsonStore'
import { shouldUpdateExpert } from './expertVersion'

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
  /** 声明式能力（后端按工具/MCP 反推） */
  capabilities?: string[]
  /** 语义化版本号（服务端专家版本；老服务端可能不返回） */
  version?: string
}

interface ExpertSyncListData {
  items: ExpertSyncItem[]
  total: number
  synced_at: number
}

interface ExpertSyncServiceDeps {
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  /** ~/.ke-work/experts 目录（由主进程 DataDirectory 解析后注入） */
  expertsDir: string
  apiBaseUrl?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const JSON_FILE_VERSION = 1
/** 服务端未返回版本号时的兜底（与服务端 DEFAULT_VERSION 一致） */
const DEFAULT_EXPERT_VERSION = '1.0.0'

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
    capabilities: item.capabilities ?? [],
    version: item.version || DEFAULT_EXPERT_VERSION,
    isExpert: true
  }
}

/** 同步完成文案：汇总版本比对结果（服务端无专家时退回简短提示） */
function describeStats(stats: ExpertSyncStats): string {
  const parts: string[] = []
  if (stats.added > 0) parts.push(`新增 ${stats.added} 个`)
  if (stats.updated > 0) parts.push(`更新 ${stats.updated} 个`)
  if (stats.kept > 0) parts.push(`保留本地 ${stats.kept} 个`)
  return parts.length > 0 ? `专家数据同步完成：${parts.join('，')}` : '专家数据同步完成'
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
  private readonly authorization: OAuth2AuthorizationProvider
  private readonly store: ExpertJsonStore
  private cachedExperts: DesktopExpert[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: ExpertSyncServiceDeps) {
    const apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.authorization = deps.authorization
    this.store = new ExpertJsonStore(deps.expertsDir)
    this.http = axios.create({ baseURL: apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): ExpertSyncStatus {
    const snapshot = this.authorization.getSnapshot(localUserId, [SCOPE_EXPERT_READ])
    return {
      status: snapshot.status,
      webUser: toWebUser(snapshot.webUser)
    }
  }

  /** 确保 expert:read 已授权；已授权时不打开浏览器 */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    await this.authorization.ensureAuthorization(localUserId, [SCOPE_EXPERT_READ], {
      reason: 'expert-sync'
    })
    return { webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  /**
   * 拉取专家列表 → 与本地版本比对合并 → 写盘 → 读回校验。
   *
   * 合并规则（服务端列表为基准，本地独有的条目按现有语义丢弃）：
   * - 本地无同 id 专家（含本地已删除）→ 采用服务端数据；
   * - 服务端版本更高 → 用服务端数据更新本地；
   * - 本地版本更高或相同 → 保留本地数据。
   *
   * 同步期间通过 onProgress 回调向调用方（IPC → 渲染层）推送阶段进度。
   */
  async sync(
    localUserId: string,
    onProgress?: (p: ExpertSyncProgress) => void
  ): Promise<{ experts: DesktopExpert[]; syncedAt: number; stats: ExpertSyncStats }> {
    this.report(onProgress, 'authorize', 5, '正在校验专家同步授权…')
    const accessToken = await this.authorization.ensureAccessToken(localUserId, [SCOPE_EXPERT_READ])
    const webUser = toWebUser(this.authorization.getWebUser(localUserId))

    this.report(onProgress, 'fetch', 12, '正在从服务器拉取专家数据…')
    const data = await this.request<ExpertSyncListData>('get', '/api/expert-sync/list', undefined, {
      // 平台参数：服务端据此渲染平台化提示词（去掉平台专属命令）
      params: { platform: 'desktop' },
      headers: { Authorization: `Bearer ${accessToken}` },
      onDownloadProgress: (e: AxiosProgressEvent): void => {
        if (!e.total) return
        const ratio = Math.min(Math.max(e.loaded / e.total, 0), 1)
        this.report(onProgress, 'fetch', Math.round(12 + ratio * 55), '正在从服务器拉取专家数据…')
      }
    })

    const previous = await this.store.read()
    const remoteExperts = data.items.map(mapExpert)
    const previousById = new Map((previous?.experts ?? []).map((expert) => [expert.id, expert]))
    const stats: ExpertSyncStats = { added: 0, updated: 0, kept: 0 }
    const merged = remoteExperts.map((remoteExpert): DesktopExpert => {
      const localExpert = previousById.get(remoteExpert.id)
      if (!localExpert) {
        stats.added += 1
        return remoteExpert
      }
      if (shouldUpdateExpert(localExpert.version, remoteExpert.version)) {
        stats.updated += 1
        return remoteExpert
      }
      stats.kept += 1
      return localExpert
    })

    const syncedAt = Date.now()
    this.report(onProgress, 'save', 75, '正在保存专家数据到本地…')
    await this.store.write({
      version: JSON_FILE_VERSION,
      syncedAt,
      syncedBy: webUser ? { webUserId: webUser.id || '', nickname: webUser.nickname || '' } : null,
      experts: merged
    })

    this.report(onProgress, 'load', 88, '正在加载本地专家数据…')
    const disk = await this.store.read()
    this.cachedExperts = disk?.experts ?? merged
    this.lastSyncedAt = disk?.syncedAt ?? syncedAt
    this.report(onProgress, 'done', 100, describeStats(stats))
    return { experts: this.cachedExperts, syncedAt: this.lastSyncedAt, stats }
  }

  /**
   * 删除本地专家（仅本机副本）。
   *
   * 不做删除墓碑：服务端仍存在的专家会在下次同步时按版本重新拉回，
   * 与服务端「下架后不再下发」的语义配合即可覆盖两种情况。
   */
  async deleteExpert(expertId: string): Promise<{ experts: DesktopExpert[]; syncedAt: number }> {
    const file = await this.store.read()
    if (!file) throw new Error('本地专家数据不存在，请先同步')
    if (!file.experts.some((expert) => expert.id === expertId)) {
      throw new Error('专家不存在，请先同步专家数据')
    }
    const experts = file.experts.filter((expert) => expert.id !== expertId)
    // syncedAt 保持不变：删除不是一次同步，避免「上次同步时间」被刷新
    await this.store.write({ ...file, experts })
    this.cachedExperts = experts
    this.lastSyncedAt = file.syncedAt
    return { experts, syncedAt: file.syncedAt }
  }

  /** 读取 ~/.ke-work/experts/experts.json 供页面展示；文件缺失返回 null。 */
  async loadLocal(): Promise<{ experts: DesktopExpert[]; syncedAt: number } | null> {
    const data = await this.store.read()
    if (!data) return null
    this.cachedExperts = data.experts
    this.lastSyncedAt = data.syncedAt
    return { experts: data.experts, syncedAt: data.syncedAt }
  }

  /** 断开同步：仅清理本地缓存与本地会话 token（决策 D1） */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
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
