import axios, { type AxiosInstance, type AxiosProgressEvent } from 'axios'
import type {
  DesktopSkill,
  SkillFileEntry,
  SkillSyncProgress,
  SkillSyncStatus,
  SkillSyncStats,
  WebUser
} from '../../preload/index.d'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_SKILL_READ } from '../oauth2/scopes'
import { hashSkillFileEntries, SkillFileStore } from './SkillFileStore'
import { SkillJsonStore } from './SkillJsonStore'
import { planSkillRuntime } from './SkillRuntimePlanner'

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
  created_at?: string
  updated_at?: string
}

interface SkillListData {
  items: WebSkillInfo[]
  total: number
  page: number
  page_size: number
}

/** 服务端技能包清单（增量同步用） */
interface WebSkillManifest {
  id: string
  name: string
  dir_name: string
  hash: string
  files: SkillFileEntry[]
  updated_at: string
}

interface SkillSyncServiceDeps {
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  /** 本地技能索引（~/.ke-work/skills/skills.json） */
  store: SkillJsonStore
  /** 本地技能包（~/.ke-work/skills） */
  fileStore: SkillFileStore
  apiBaseUrl?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const JSON_FILE_VERSION = 1
const PAGE_SIZE = 100

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

/** 二进制响应体 → Uint8Array（axios arraybuffer / Buffer 兼容） */
function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new Error('技能包内容为空')
}

/** axios 错误 → 可读 message（兼容 arraybuffer 错误体） */
function toErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : '网络请求失败'
  }
  const data = error.response?.data as unknown
  if (data instanceof ArrayBuffer) {
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(data))) as {
        message?: string
        detail?: string
      }
      return parsed.message || parsed.detail || error.message || '网络请求失败'
    } catch {
      return error.message || '网络请求失败'
    }
  }
  const record = data as { message?: string; detail?: string } | undefined
  return record?.message || record?.detail || error.message || '网络请求失败'
}

/**
 * 桌面端 Web 技能同步服务。
 *
 * 职责：OAuth2 授权（skill:read）→ 拉取技能列表 → 按 manifest 增量下载技能包 →
 * 落盘到 ~/.ke-work/skills/<dirName> → 原子写 skills.json → 读回作为返回值。
 * 页面展示以本地 skills.json 为事实源（本地优先，离线可用）。
 */
export class SkillSyncService {
  private readonly http: AxiosInstance
  private readonly authorization: OAuth2AuthorizationProvider
  private readonly store: SkillJsonStore
  private readonly fileStore: SkillFileStore
  private cachedSkills: DesktopSkill[] = []
  private lastSyncedAt: number | null = null

  constructor(deps: SkillSyncServiceDeps) {
    const apiBaseUrl = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.authorization = deps.authorization
    this.store = deps.store
    this.fileStore = deps.fileStore
    this.http = axios.create({ baseURL: apiBaseUrl, timeout: 15_000 })
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

  /** 读取 ~/.ke-work/skills/skills.json 并做磁盘一致性标记；文件缺失返回 null。 */
  async loadLocal(): Promise<{ skills: DesktopSkill[]; syncedAt: number } | null> {
    const data = await this.store.read()
    if (!data) return null
    this.cachedSkills = data.skills.map((skill) => this.normalizeLocalSkill(skill))
    this.lastSyncedAt = data.syncedAt
    return { skills: this.cachedSkills, syncedAt: data.syncedAt }
  }

  getCachedSkills(): DesktopSkill[] {
    return this.cachedSkills
  }

  /** 同步：拉列表 → 增量下载 → 原子落盘 → 写索引 → 读回。 */
  async sync(
    localUserId: string,
    onProgress?: (progress: SkillSyncProgress) => void
  ): Promise<{ skills: DesktopSkill[]; syncedAt: number; stats: SkillSyncStats }> {
    this.report(onProgress, 'authorize', 3, '正在校验技能同步授权…')
    const accessToken = await this.authorization.ensureAccessToken(localUserId, [SCOPE_SKILL_READ])
    const webUser = toWebUser(this.authorization.getWebUser(localUserId))

    this.report(onProgress, 'fetch', 8, '正在拉取技能列表…')
    const data = await this.request<SkillListData>('get', '/api/skill/list', undefined, {
      params: { page: 1, page_size: PAGE_SIZE },
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    const previous = await this.store.read()
    const previousById = new Map((previous?.skills ?? []).map((skill) => [skill.id, skill]))
    const stats: SkillSyncStats = { added: 0, updated: 0, unchanged: 0, failed: 0, stale: 0 }
    const results: DesktopSkill[] = []
    const items = data.items ?? []

    for (const [index, item] of items.entries()) {
      const base = 12 + Math.round((index / Math.max(items.length, 1)) * 70)
      const previousSkill = previousById.get(item.id)
      try {
        const manifest = await this.fetchManifest(accessToken, item.id)
        if (this.isUnchanged(previousSkill, manifest)) {
          stats.unchanged += 1
          results.push({ ...previousSkill!, stale: false, missing: false })
          continue
        }

        this.report(onProgress, 'download', base, `正在下载技能「${item.name}」…`, {
          skill: item.name
        })
        const buffer = await this.downloadPackage(accessToken, item.id, (event) => {
          this.report(onProgress, 'download', base, `正在下载技能「${item.name}」…`, {
            skill: item.name,
            received: event.loaded,
            total: event.total ?? 0
          })
        })

        const pkg = this.fileStore.extractPackage(buffer, item.id)
        const files = await this.fileStore.writePackage(pkg)
        const runtime = planSkillRuntime(this.fileStore.dirFor(pkg.dirName))
        const keepInstalled =
          previousSkill?.installed === true && previousSkill.dirName === pkg.dirName
        results.push({
          ...mapSkill(item),
          dirName: pkg.dirName,
          files,
          runtime: { kinds: runtime.kinds, entry: runtime.entry, reasons: runtime.reasons },
          installed: keepInstalled,
          installedAt: keepInstalled ? (previousSkill?.installedAt ?? null) : null,
          stale: false,
          missing: false
        })
        if (previousSkill) stats.updated += 1
        else stats.added += 1
      } catch (err) {
        stats.failed += 1
        console.warn(`[skill-sync] 技能「${item.name}」同步失败:`, err)
        if (previousSkill) {
          results.push({
            ...previousSkill,
            stale: true,
            missing: !this.fileStore.hasSkill(previousSkill.dirName)
          })
        }
      }
    }

    const serverIds = new Set(items.map((item) => item.id))
    for (const previousSkill of previous?.skills ?? []) {
      if (serverIds.has(previousSkill.id)) continue
      stats.stale += 1
      results.push({
        ...previousSkill,
        stale: true,
        missing: !this.fileStore.hasSkill(previousSkill.dirName)
      })
    }

    const syncedAt = Date.now()
    this.report(onProgress, 'save', 88, '正在保存技能索引…')
    await this.store.write({
      version: JSON_FILE_VERSION,
      syncedAt,
      syncedBy: webUser ? { webUserId: webUser.id ?? '', nickname: webUser.nickname ?? '' } : null,
      skills: results
    })

    this.report(onProgress, 'load', 94, '正在加载本地技能…')
    const disk = await this.store.read()
    this.cachedSkills = (disk?.skills ?? results).map((skill) => this.normalizeLocalSkill(skill))
    this.lastSyncedAt = disk?.syncedAt ?? syncedAt
    this.report(onProgress, 'done', 100, '技能同步完成')
    return { skills: this.cachedSkills, syncedAt: this.lastSyncedAt, stats }
  }

  /** 断开同步：仅清理本地会话 token 与内存缓存（决策 D1，磁盘技能包保留） */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
    this.cachedSkills = []
    this.lastSyncedAt = null
  }

  /** 本地条目归一化：补齐可选字段并按磁盘事实标记 missing */
  private normalizeLocalSkill(skill: DesktopSkill): DesktopSkill {
    return {
      ...skill,
      files: skill.files ?? [],
      runtime: skill.runtime ?? null,
      installed: skill.installed === true,
      installedAt: skill.installedAt ?? null,
      missing: !this.fileStore.hasSkill(skill.dirName)
    }
  }

  /** 服务端 manifest 与本地记录一致且技能目录存在时视为未变化（可跳过下载） */
  private isUnchanged(
    previous: DesktopSkill | undefined,
    manifest: WebSkillManifest | null
  ): boolean {
    if (!previous?.dirName || !previous.files?.length) return false
    if (!this.fileStore.hasSkill(previous.dirName)) return false
    if (!manifest) return false
    return manifest.hash === hashSkillFileEntries(previous.files)
  }

  /** manifest 用于增量判断；服务端未提供时返回 null（退化为全量下载） */
  private async fetchManifest(
    accessToken: string,
    skillId: string
  ): Promise<WebSkillManifest | null> {
    try {
      return await this.request<WebSkillManifest>(
        'get',
        `/api/skill/${encodeURIComponent(skillId)}/manifest`,
        undefined,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
    } catch {
      return null
    }
  }

  /** 下载技能包（zip → Uint8Array） */
  private async downloadPackage(
    accessToken: string,
    skillId: string,
    onProgress?: (event: AxiosProgressEvent) => void
  ): Promise<Uint8Array> {
    try {
      const response = await this.http.get<ArrayBuffer>(
        `/api/skill/${encodeURIComponent(skillId)}/download`,
        {
          responseType: 'arraybuffer',
          timeout: 120_000,
          headers: { Authorization: `Bearer ${accessToken}` },
          onDownloadProgress: onProgress
        }
      )
      return toUint8Array(response.data)
    } catch (error) {
      throw new Error(toErrorMessage(error))
    }
  }

  private report(
    onProgress: ((progress: SkillSyncProgress) => void) | undefined,
    phase: SkillSyncProgress['phase'],
    percent: number,
    message: string,
    extra?: Partial<SkillSyncProgress>
  ): void {
    onProgress?.({ phase, percent, message, ...extra })
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
      throw new Error(toErrorMessage(error))
    }
  }
}
