import axios, { type AxiosInstance, type AxiosProgressEvent } from 'axios'
import type {
  AutomationSchedule,
  AutomationTemplateSyncProgress,
  AutomationTemplateSyncStats,
  AutomationTemplateSyncStatus,
  DesktopAutomationTemplate,
  WebUser
} from '../../shared/contracts'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_TEMPLATE_READ } from '../oauth2/scopes'
import { compareExpertVersion } from '../experts/expertVersion'
import { AutomationTemplateJsonStore } from './AutomationTemplateJsonStore'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

/** Web 端 contextMode 取值（'files' 与桌面端的 'local' 同义） */
type WebContextMode = 'default' | 'files' | 'knowledge'

/**
 * 服务端下发的模板（`AutomationTemplateResponse`，camelCase 序列化）。
 *
 * 与桌面端 `DesktopAutomationTemplate` 的差异只有两处：`promptParts` 里的文件段
 * 指向服务端 attachment_id（本机无对应实体），以及 `contextMode` 多一个 'files'。
 */
interface AutomationTemplateSyncItem {
  id: string
  name: string
  description: string
  icon: string
  category: string
  version: string
  promptText: string
  promptParts: Array<{
    type: 'text' | 'file'
    text?: string | null
    attachmentId?: string | null
    filename?: string | null
  }>
  schedule: AutomationSchedule
  freqSummary: string
  validitySummary: string
  model: string | null
  customModelId: string | null
  providerId: string | null
  modelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: WebContextMode
  skillIds: string[]
  kbIds: string[]
  workspaceId: string | null
  workspaceName: string | null
  allowNetwork: boolean
  allowShell: boolean
  fullAccess: boolean
  createdAt: number
  updatedAt: number
}

interface AutomationTemplateListData {
  items: AutomationTemplateSyncItem[]
  total: number
  page: number
  page_size: number
}

interface AutomationTemplateSyncServiceDeps {
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  /** ~/.ke-work/automation-templates 目录（由主进程 DataDirectory 解析后注入） */
  templatesDir: string
  apiBaseUrl?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const JSON_FILE_VERSION = 1
/** 服务端 page_size 上限；超过 100 个模板时按 total 翻页 */
const PAGE_SIZE = 100

/** Web 的 'files' 与桌面端的 'local' 同义（都是本地文件上下文） */
function mapContextMode(mode: WebContextMode): DesktopAutomationTemplate['contextMode'] {
  return mode === 'files' ? 'local' : mode
}

/**
 * 服务端模板 → 本地模板。
 *
 * `promptParts` 只保留纯文本段：服务端的文件段引用的是 attachment_id，
 * 桌面端没有对应的附件实体，落不了地。提示词正文另有 `promptText` 兜底，
 * 建任务时用不到的部分不会丢内容（见 AutomationTemplatesPage 的建任务逻辑）。
 */
function mapTemplate(item: AutomationTemplateSyncItem): DesktopAutomationTemplate {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? '',
    icon: item.icon || '⏰',
    category: item.category ?? '',
    version: item.version || '1.0.0',
    promptText: item.promptText ?? '',
    promptParts: (item.promptParts ?? [])
      .filter(
        (part): part is { type: 'text'; text?: string | null } =>
          part.type === 'text' && typeof part.text === 'string'
      )
      .map((part) => ({ type: 'text', text: part.text ?? '' })),
    schedule: {
      ...item.schedule,
      weekDays: [...(item.schedule.weekDays ?? [])],
      weekIntervalDays: [...(item.schedule.weekIntervalDays ?? [])]
    },
    freqSummary: item.freqSummary ?? '',
    validitySummary: item.validitySummary ?? '',
    model: item.model,
    customModelId: item.customModelId,
    expertId: item.expertId,
    expertName: item.expertName,
    contextMode: mapContextMode(item.contextMode),
    skillIds: [...(item.skillIds ?? [])],
    workspaceId: item.workspaceId,
    workspaceName: item.workspaceName,
    fullAccess: item.fullAccess,
    // 以下字段本地只存不用：桌面任务草稿没有对应项（见 AutomationTaskDraft）
    providerId: item.providerId,
    modelId: item.modelId,
    kbIds: [...(item.kbIds ?? [])],
    allowNetwork: item.allowNetwork,
    allowShell: item.allowShell,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }
}

/** 同步时是否需要服务端版本覆盖本地副本：本地无版本一律视为需要更新 */
function shouldUpdateTemplate(
  localVersion?: string | null,
  remoteVersion?: string | null
): boolean {
  if (!localVersion) return true
  return compareExpertVersion(remoteVersion, localVersion) > 0
}

/** 同步完成文案：汇总版本比对结果（服务端无模板时退回简短提示） */
function describeStats(stats: AutomationTemplateSyncStats): string {
  const parts: string[] = []
  if (stats.added > 0) parts.push(`新增 ${stats.added} 个`)
  if (stats.updated > 0) parts.push(`更新 ${stats.updated} 个`)
  if (stats.kept > 0) parts.push(`保留本地 ${stats.kept} 个`)
  return parts.length > 0 ? `定时模板同步完成：${parts.join('，')}` : '定时模板同步完成'
}

/**
 * 桌面版 Web 定时模板同步服务。
 *
 * 职责：OAuth2 Authorization Code + PKCE 授权、template:read scope 拉取模板列表，
 * 映射后原子写入 ~/.ke-work/automation-templates/templates.json，并以文件读回结果作为
 * 同步返回值，保证页面展示的数据与磁盘一致。
 */
export class AutomationTemplateSyncService {
  private readonly http: AxiosInstance
  private readonly authorization: OAuth2AuthorizationProvider
  private readonly store: AutomationTemplateJsonStore
  private cachedTemplates: DesktopAutomationTemplate[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: AutomationTemplateSyncServiceDeps) {
    const apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.authorization = deps.authorization
    this.store = new AutomationTemplateJsonStore(deps.templatesDir)
    this.http = axios.create({ baseURL: apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): AutomationTemplateSyncStatus {
    const snapshot = this.authorization.getSnapshot(localUserId, [SCOPE_TEMPLATE_READ])
    return {
      status: snapshot.status,
      webUser: toWebUser(snapshot.webUser)
    }
  }

  /** 确保 template:read 已授权；已授权时不打开浏览器 */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    await this.authorization.ensureAuthorization(localUserId, [SCOPE_TEMPLATE_READ], {
      reason: 'automation-template-sync'
    })
    return { webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  /**
   * 拉取模板列表 → 与本地版本比对合并 → 写盘 → 读回校验。
   *
   * 合并规则（服务端列表为基准，本地独有的条目按现有语义丢弃）：
   * - 本地无同 id 模板（含本地已删除）→ 采用服务端数据；
   * - 服务端版本更高 → 用服务端数据更新本地；
   * - 本地版本更高或相同 → 保留本地数据。
   *
   * 同步期间通过 onProgress 回调向调用方（IPC → 渲染层）推送阶段进度。
   */
  async sync(
    localUserId: string,
    onProgress?: (p: AutomationTemplateSyncProgress) => void
  ): Promise<{
    templates: DesktopAutomationTemplate[]
    syncedAt: number
    stats: AutomationTemplateSyncStats
  }> {
    this.report(onProgress, 'authorize', 5, '正在校验定时模板同步授权…')
    const accessToken = await this.authorization.ensureAccessToken(localUserId, [
      SCOPE_TEMPLATE_READ
    ])
    const webUser = toWebUser(this.authorization.getWebUser(localUserId))

    this.report(onProgress, 'fetch', 12, '正在从服务器拉取定时模板…')
    const items: AutomationTemplateSyncItem[] = []
    let total = 0
    let page = 1
    // 服务端 page_size 有上限（100），超过就翻页取全量，避免静默截断
    for (;;) {
      const data = await this.request<AutomationTemplateListData>(
        'get',
        '/api/automation-template-sync/list',
        undefined,
        {
          params: { page, page_size: PAGE_SIZE },
          headers: { Authorization: `Bearer ${accessToken}` },
          onDownloadProgress: (e: AxiosProgressEvent): void => {
            if (!e.total) return
            const ratio = Math.min(Math.max(e.loaded / e.total, 0), 1)
            const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1)
            const done = (page - 1 + ratio) / pages
            this.report(
              onProgress,
              'fetch',
              Math.round(12 + Math.min(done, 1) * 55),
              '正在从服务器拉取定时模板…'
            )
          }
        }
      )
      total = data.total
      items.push(...data.items)
      if (items.length >= total || data.items.length === 0) break
      page += 1
    }

    const previous = await this.store.read()
    const remoteTemplates = items.map(mapTemplate)
    const previousById = new Map(
      (previous?.templates ?? []).map((template) => [template.id, template])
    )
    const stats: AutomationTemplateSyncStats = { added: 0, updated: 0, kept: 0 }
    const merged = remoteTemplates.map((remoteTemplate): DesktopAutomationTemplate => {
      const localTemplate = previousById.get(remoteTemplate.id)
      if (!localTemplate) {
        stats.added += 1
        return remoteTemplate
      }
      if (shouldUpdateTemplate(localTemplate.version, remoteTemplate.version)) {
        stats.updated += 1
        return remoteTemplate
      }
      stats.kept += 1
      return localTemplate
    })

    const syncedAt = Date.now()
    this.report(onProgress, 'save', 75, '正在保存定时模板到本地…')
    await this.store.write({
      version: JSON_FILE_VERSION,
      syncedAt,
      syncedBy: webUser ? { webUserId: webUser.id || '', nickname: webUser.nickname || '' } : null,
      templates: merged
    })

    this.report(onProgress, 'load', 88, '正在加载本地定时模板…')
    const disk = await this.store.read()
    this.cachedTemplates = disk?.templates ?? merged
    this.lastSyncedAt = disk?.syncedAt ?? syncedAt
    this.report(onProgress, 'done', 100, describeStats(stats))
    return { templates: this.cachedTemplates, syncedAt: this.lastSyncedAt, stats }
  }

  /**
   * 删除本地模板（仅本机副本）。
   *
   * 不做删除墓碑：服务端仍存在的模板会在下次同步时按版本重新拉回，
   * 与服务端「下架后不再下发」的语义配合即可覆盖两种情况。
   */
  async deleteTemplate(
    templateId: string
  ): Promise<{ templates: DesktopAutomationTemplate[]; syncedAt: number }> {
    const file = await this.store.read()
    if (!file) throw new Error('本地定时模板不存在，请先同步')
    if (!file.templates.some((template) => template.id === templateId)) {
      throw new Error('模板不存在，请先同步定时模板')
    }
    const templates = file.templates.filter((template) => template.id !== templateId)
    // syncedAt 保持不变：删除不是一次同步，避免「上次同步时间」被刷新
    await this.store.write({ ...file, templates })
    this.cachedTemplates = templates
    this.lastSyncedAt = file.syncedAt
    return { templates, syncedAt: file.syncedAt }
  }

  /** 读取 ~/.ke-work/automation-templates/templates.json 供页面展示；文件缺失返回 null。 */
  async loadLocal(): Promise<{
    templates: DesktopAutomationTemplate[]
    syncedAt: number
  } | null> {
    const data = await this.store.read()
    if (!data) return null
    this.cachedTemplates = data.templates
    this.lastSyncedAt = data.syncedAt
    return { templates: data.templates, syncedAt: data.syncedAt }
  }

  /** 断开同步：仅清理本地缓存与本地会话 token（决策 D1） */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
    this.cachedTemplates = []
    this.lastSyncedAt = null
  }

  private report(
    onProgress: ((p: AutomationTemplateSyncProgress) => void) | undefined,
    phase: AutomationTemplateSyncProgress['phase'],
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
