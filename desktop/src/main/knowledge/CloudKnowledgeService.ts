/**
 * 云知识库服务（只读）——把 Web 版「知识库」页面的个人库 / 公共库 / 共享给我的同步到桌面端。
 *
 * 与本地知识库（`KnowledgeService` + `KnowledgeStore`，落 index.db）**完全分开**：
 * 本地表有 `UNIQUE(user_id, name)`，且 `reorderBases` 要求传入 id 集合与本地该 kind 全量
 * 完全一致——云库混进去会撞唯一约束、破坏拖拽排序。因此云侧**只读、不落库**，
 * 文档原文按需缓存到磁盘（`~/.ke-work/cache/cloud-kb/<kbId>/<docId>/`）供预览复用。
 * 缓存放 `cache/` 而不是知识库目录：知识库目录可由用户改成网盘/外置盘，缓存是派生物。
 *
 * 授权：所有云接口都要求 `knowledge:read`（服务端 `require_scope`）。
 * **取 token 不触发交互式授权**（与 `oauth2/mcpAuth.ts` 同一取舍）：建连/加载都发生在
 * 页面加载这类非用户显式动作上，弹浏览器很突兀；缺权限时抛 `CloudAuthRequiredError`，
 * 由渲染层提示用户去「授权管理」开启，或点「去授权」走既有 `oauth2:authorize` 增量授权。
 */

import axios, { type AxiosInstance } from 'axios'
import { existsSync, mkdirSync, statSync } from 'fs'
import { copyFile, readFile, rename, writeFile } from 'fs/promises'
import { basename, extname, resolve, sep } from 'path'

import { SCOPE_KNOWLEDGE_READ } from '../oauth2/scopes'
import { loadFileText, MAX_BINARY_BYTES, PREVIEW_PAGE_CHARS } from '../workspace/FileLoaders'

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
/** 普通接口超时（与 expert/model/skill 同步一致） */
const REQUEST_TIMEOUT_MS = 15_000
/** 下载原文超时：文档可能几十 MB，给足时间 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 文档列表在内存里的保鲜期（Markdown 插图按 relPath 反查文档时避免每张图都拉一次列表） */
const DOC_LIST_TTL_MS = 60_000
/** 缓存文件名长度上限（服务端给的名字不可信，先净化再截断） */
const CACHE_NAME_MAX_LEN = 120

/** 云接口要求的 scope（服务端 kb_api 全部挂 require_scope("knowledge:read")） */
const REQUIRED_SCOPES: readonly string[] = [SCOPE_KNOWLEDGE_READ]

/** 列表栏目：与 Web 版侧栏的 apiScope 对齐（「共享给我的」走邀请接口，不在此列） */
export type CloudKbScope = 'personal' | 'public'

export interface CloudKbSummary {
  id: string
  name: string
  description: string
  docsCount: number
  chunksCount: number
  sizeDisplay: string
  visibility: 'private' | 'public'
  isOwner: boolean
  ownerName: string | null
  access?: 'owner' | 'write' | 'read'
  updatedAt: string
}

export interface CloudShareEntry {
  shareId: string
  kbId: string
  kbName: string
  ownerName: string
  permission: 'read' | 'write'
  status: string
  expiresAt: string | null
  createdAt: string
}

export interface CloudDocSummary {
  id: string
  name: string
  type: string
  sizeDisplay: string
  status: string
  chunksCount: number
  folder: string | null
  uploadedAt: string
  indexedAt: string | null
  errorMessage: string | null
}

export interface CloudKnowledgeStatus {
  /** 是否已绑定 Web 账号 */
  linked: boolean
  /** 是否已授予 knowledge:read（未授予时所有列表接口都会抛 CloudAuthRequiredError） */
  hasScope: boolean
}

/** 缺授权：渲染层据此提示「去授权」，而不是把它当成普通网络错误 */
export class CloudAuthRequiredError extends Error {
  readonly code = 'auth-required'
  constructor(message: string) {
    super(message)
    this.name = 'CloudAuthRequiredError'
  }
}

export interface CloudKnowledgeServiceDeps {
  authorization: {
    getSnapshot(
      localUserId: string,
      required: readonly string[]
    ): { status: 'authorized' | 'unauthorized'; webUser: unknown | null }
    hasScopes(localUserId: string, required: readonly string[]): boolean
    /** 非交互取 token：取不到返回 null，绝不触发授权（见 OAuth2AuthorizationProvider） */
    tryEnsureAccessToken(localUserId: string, required: readonly string[]): Promise<string | null>
  }
  /** 后端 API 基址（空串回落回环默认值，与各同步服务一致） */
  apiBaseUrl?: string
  /** 文档原文缓存根目录（~/.ke-work/cache/cloud-kb） */
  cacheDir: string
  /** 测试注入 */
  http?: AxiosInstance
}

/** 后端统一响应信封 */
interface WebEnvelope<T> {
  code: number
  data: T
  message?: string
}

export class CloudKnowledgeService {
  private readonly http: AxiosInstance
  private readonly cacheDir: string
  /** 文档列表内存缓存：key = `${userId}:${kbId}` */
  private readonly docListCache = new Map<string, { items: CloudDocSummary[]; at: number }>()
  /** 下载单飞：同一文档并发只拉一次（key = `${kbId}/${docId}`） */
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(private readonly deps: CloudKnowledgeServiceDeps) {
    const baseURL = (deps.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
    this.http = deps.http ?? axios.create({ baseURL, timeout: REQUEST_TIMEOUT_MS })
    this.cacheDir = deps.cacheDir
  }

  /** 登录与授权状态（驱动侧栏的「去授权」提示） */
  getStatus(localUserId: string): CloudKnowledgeStatus {
    const snapshot = this.deps.authorization.getSnapshot(localUserId, REQUIRED_SCOPES)
    return {
      linked: Boolean(snapshot.webUser),
      hasScope: this.deps.authorization.hasScopes(localUserId, REQUIRED_SCOPES)
    }
  }

  /** 云个人知识库 / 云公共知识库（对应 Web 版侧栏同名的两个栏目） */
  async listBases(
    localUserId: string,
    scope: CloudKbScope,
    options: { page?: number; pageSize?: number; search?: string } = {}
  ): Promise<{ items: CloudKbSummary[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 100)))
    const data = await this.request<{
      items?: unknown[]
      total?: number
      page?: number
      page_size?: number
    }>(localUserId, 'get', '/api/knowledge-bases', {
      params: {
        scope,
        page,
        page_size: pageSize,
        ...(options.search ? { search: options.search } : {})
      }
    })
    const items = Array.isArray(data?.items) ? data.items.map(mapKb) : []
    return {
      items,
      total: data?.total ?? items.length,
      page: data?.page ?? page,
      pageSize: data?.page_size ?? pageSize
    }
  }

  /** 共享给我的：待接受 + 已接受（与 Web 版侧栏同源） */
  async listInvitations(localUserId: string): Promise<CloudShareEntry[]> {
    const data = await this.request<{ items?: unknown[] } | unknown[]>(
      localUserId,
      'get',
      '/api/knowledge-bases/shares/invitations'
    )
    const raw = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
    return raw.map(mapShare)
  }

  /** 接受 / 拒绝分享邀请（服务端按参与者身份鉴权，读权限即可） */
  async respondInvitation(localUserId: string, shareId: string, accept: boolean): Promise<void> {
    await this.request(
      localUserId,
      'post',
      `/api/knowledge-bases/shares/${encodeURIComponent(shareId)}/${accept ? 'accept' : 'reject'}`
    )
    // 邀请状态变了，列表缓存作废
    this.docListCache.clear()
  }

  /** 知识库详情（只读详情页头部） */
  async getBase(localUserId: string, kbId: string): Promise<CloudKbSummary> {
    const data = await this.request<unknown>(
      localUserId,
      'get',
      `/api/knowledge-bases/${encodeURIComponent(kbId)}`
    )
    return mapKb(data)
  }

  /** 文档列表（只读详情页主体） */
  async listDocuments(
    localUserId: string,
    kbId: string,
    options: { page?: number; pageSize?: number; search?: string; folder?: string | null } = {}
  ): Promise<{ items: CloudDocSummary[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.trunc(options.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 100)))
    const data = await this.request<{
      items?: unknown[]
      total?: number
      page?: number
      page_size?: number
    }>(localUserId, 'get', `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`, {
      params: {
        page,
        page_size: pageSize,
        ...(options.search ? { search: options.search } : {}),
        ...(options.folder ? { folder: options.folder } : {})
      }
    })
    const items = Array.isArray(data?.items) ? data.items.map(mapDoc) : []
    if (page === 1 && !options.search && !options.folder) {
      this.docListCache.set(this.cacheKey(localUserId, kbId), { items, at: Date.now() })
    }
    return {
      items,
      total: data?.total ?? items.length,
      page: data?.page ?? page,
      pageSize: data?.page_size ?? pageSize
    }
  }

  /**
   * 读取文档原文（预览用）。
   *
   * 原文会先落到本地缓存目录再按与本地知识库**同一套**解析器取文本/字节
   * （`loadFileText` + 分页游标），因此预览组件与本地库完全同构。
   */
  async readDocument(
    localUserId: string,
    kbId: string,
    docId: string,
    as: 'text' | 'bytes',
    options: { cursor?: number } = {}
  ): Promise<{
    content?: string
    truncated?: boolean
    cursor?: number
    totalChars?: number
    bytes?: Uint8Array
    ext: string
    name: string
  }> {
    const doc = await this.fetchDocDetail(localUserId, kbId, docId)
    const target = await this.ensureCached(localUserId, kbId, doc)
    const ext = doc.ext
    if (as === 'text') {
      const loaded = await loadFileText(target, ext, {
        cursor: options.cursor,
        maxChars: PREVIEW_PAGE_CHARS
      })
      return {
        content: loaded.content,
        truncated: loaded.truncated,
        cursor: loaded.cursor,
        totalChars: loaded.totalChars,
        ext,
        name: doc.name
      }
    }
    if (statSync(target).size > MAX_BINARY_BYTES) throw new Error('文件过大，暂不支持预览')
    const buffer = await readFile(target)
    return { bytes: new Uint8Array(buffer), ext, name: doc.name }
  }

  /**
   * 读取云文档内的插图（Markdown 相对路径渲染用）。
   *
   * 云端没有本地「文档记录」，只能按 `relPath` 在文档列表里反查——列表带 60s 内存缓存，
   * 一张图不会拉一次列表。
   */
  async readImageBytes(
    localUserId: string,
    kbId: string,
    relPath: string
  ): Promise<{ ext: string; bytes: Uint8Array }> {
    const doc = await this.findDocByRelPath(localUserId, kbId, relPath)
    if (!doc) throw new Error('图片文件不存在')
    const target = await this.ensureCached(localUserId, kbId, doc)
    if (statSync(target).size > MAX_BINARY_BYTES) throw new Error('图片文件过大，暂不支持预览')
    const buffer = await readFile(target)
    return { ext: doc.ext, bytes: new Uint8Array(buffer) }
  }

  /** 另存为：把（已缓存的）原文写到用户选定路径 */
  async saveDocumentAs(
    localUserId: string,
    kbId: string,
    docId: string,
    targetPath: string
  ): Promise<void> {
    const doc = await this.fetchDocDetail(localUserId, kbId, docId)
    const source = await this.ensureCached(localUserId, kbId, doc)
    await copyFile(source, targetPath)
  }

  /** 登出：清内存缓存（磁盘缓存按 kbId/docId 保留，下次登录仍可命中） */
  disconnect(): void {
    this.docListCache.clear()
  }

  // ── 内部实现 ──

  private cacheKey(localUserId: string, kbId: string): string {
    return `${localUserId}:${kbId}`
  }

  /**
   * 取一枚可用 access token；缺授权时抛 CloudAuthRequiredError（**绝不弹浏览器**）。
   *
   * 用 `tryEnsureAccessToken` 而非 `ensureAccessToken`：后者在 refresh 失效时会
   * 清理本地 token 并重新走授权流程，也就是弹浏览器——而这里的调用发生在页面挂载、
   * 预览等后台路径上，用户没点任何东西不该蹦出授权窗口。
   */
  private async accessToken(localUserId: string): Promise<string> {
    if (!this.deps.authorization.hasScopes(localUserId, REQUIRED_SCOPES)) {
      throw new CloudAuthRequiredError(
        `需要授予「${SCOPE_KNOWLEDGE_READ}」后才能访问云知识库：请在 设置 - 账号 - 授权管理 中开启`
      )
    }
    const token = await this.deps.authorization.tryEnsureAccessToken(localUserId, REQUIRED_SCOPES)
    if (!token) {
      throw new CloudAuthRequiredError('访问凭据已失效：请重新登录，或在授权管理中重新开启后再试')
    }
    return token
  }

  private async request<T>(
    localUserId: string,
    method: 'get' | 'post',
    path: string,
    config: { params?: Record<string, unknown> } = {}
  ): Promise<T> {
    const token = await this.accessToken(localUserId)
    try {
      const response = await this.http.request<WebEnvelope<T>>({
        method,
        url: path,
        params: config.params,
        headers: { Authorization: `Bearer ${token}` }
      })
      const envelope = response.data
      if (!envelope || typeof envelope.code !== 'number') {
        throw new Error('Web 服务返回了无法识别的响应')
      }
      if (envelope.code !== 0) throw new Error(envelope.message || 'Web 服务返回错误')
      return envelope.data
    } catch (error) {
      throw this.toReadableError(error)
    }
  }

  /**
   * 错误归一：401/403 一律表达为"需要授权"（可能是服务端撤销了授权或 token 过期），
   * 其余取出后端 message 供界面展示。绝不把 axios 的原始堆栈抛给渲染层。
   */
  private toReadableError(error: unknown): Error {
    if (error instanceof CloudAuthRequiredError) return error
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0
      if (status === 401 || status === 403) {
        return new CloudAuthRequiredError(
          '云知识库授权已失效：请在 设置 - 账号 - 授权管理 中重新开启'
        )
      }
      const data = error.response?.data as { message?: unknown; detail?: unknown } | undefined
      const message =
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.detail === 'string' && data.detail) ||
        error.message
      return new Error(`云知识库请求失败：${message}`)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /** 文档详情（名字/扩展名/更新时间——缓存新鲜度判定要用） */
  private async fetchDocDetail(
    localUserId: string,
    kbId: string,
    docId: string
  ): Promise<CachedDocMeta> {
    const data = await this.request<Record<string, unknown>>(
      localUserId,
      'get',
      `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`
    )
    const name = sanitizeFileName(str(data?.name) || `doc-${docId}`)
    return {
      id: docId,
      name,
      ext: extname(name).toLowerCase().replace(/^\./, ''),
      uploadedAt: str(data?.uploaded_at)
    }
  }

  /** 按 relPath（folder/name）在文档列表里反查文档 */
  private async findDocByRelPath(
    localUserId: string,
    kbId: string,
    relPath: string
  ): Promise<CachedDocMeta | null> {
    const wanted = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    const key = this.cacheKey(localUserId, kbId)
    const cached = this.docListCache.get(key)
    let items = cached && Date.now() - cached.at < DOC_LIST_TTL_MS ? cached.items : null
    if (!items) {
      const page = await this.listDocuments(localUserId, kbId, { pageSize: 100 })
      items = page.items
    }
    const hit = items.find((item) => relPathOf(item) === wanted)
    if (!hit) return null
    const name = sanitizeFileName(hit.name)
    return {
      id: hit.id,
      name,
      ext: extname(name).toLowerCase().replace(/^\./, ''),
      uploadedAt: hit.uploadedAt
    }
  }

  /**
   * 确保原文在本地缓存里，返回缓存文件的绝对路径。
   *
   * 命中规则：文件存在、非空，且**不早于**服务端记录的更新时间（`uploaded_at`）——
   * 云端文档被替换后会重新拉取，不会预览到旧内容。
   * 同一文档的并发请求合流成一次下载（Markdown 多张插图会同时进来）。
   */
  private async ensureCached(
    localUserId: string,
    kbId: string,
    doc: CachedDocMeta
  ): Promise<string> {
    const dir = this.resolveCacheDir(kbId, doc.id)
    const target = resolve(dir, doc.name)
    this.assertInside(dir, target)

    if (isCacheHit(target, doc.uploadedAt)) return target

    const key = `${kbId}/${doc.id}`
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const task = this.download(localUserId, kbId, doc, dir, target).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  /** 真正下载：先写临时文件再改名，避免失败时留下半截文件被当成命中 */
  private async download(
    localUserId: string,
    kbId: string,
    doc: CachedDocMeta,
    dir: string,
    target: string
  ): Promise<string> {
    const token = await this.accessToken(localUserId)
    let payload: ArrayBuffer
    try {
      const response = await this.http.request<ArrayBuffer>({
        method: 'post',
        url: `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(doc.id)}/download`,
        headers: { Authorization: `Bearer ${token}` },
        // 二进制响应单独放宽超时（文档可能几十 MB）
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS
      })
      payload = response.data
    } catch (error) {
      throw this.toReadableError(error)
    }

    mkdirSync(dir, { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, Buffer.from(payload))
    await rename(tmp, target)
    return target
  }

  private resolveCacheDir(kbId: string, docId: string): string {
    return resolve(this.cacheDir, sanitizeFileName(kbId), sanitizeFileName(docId))
  }

  /** 防路径穿越：缓存文件必须落在该文档自己的目录内 */
  private assertInside(dir: string, target: string): void {
    const root = resolve(dir)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('文档名非法')
    }
  }
}

interface CachedDocMeta {
  id: string
  name: string
  ext: string
  uploadedAt: string
}

/** 列表项 → relPath（与服务端 folder 语义一致：'' 或 null 表示根目录） */
function relPathOf(item: CloudDocSummary): string {
  const folder = (item.folder ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return folder ? `${folder}/${item.name}` : item.name
}

/**
 * 缓存是否可用：文件存在、非空，且不早于服务端记录的更新时间。
 *
 * 0 字节按未命中处理（下载中断留下的空文件不能被当成内容）。
 */
function isCacheHit(target: string, uploadedAt: string): boolean {
  if (!existsSync(target)) return false
  const stat = statSync(target)
  if (!stat.isFile() || stat.size === 0) return false
  const uploaded = parseServerTime(uploadedAt)
  // 拿不到服务端时间时按存在即命中：宁可偶尔用缓存，也不要每次预览都重下
  return uploaded === null || stat.mtimeMs >= uploaded
}

/**
 * 解析服务端时间字符串为毫秒时间戳。
 *
 * 后端 datetime 是**朴素 UTC**（`datetime.utcnow()`），直接 `Date.parse` 会被当成本地时间、
 * 整体偏 8 小时；因此无时区后缀时补 `Z` 按 UTC 解析（带时区后缀的原样交给 Date.parse）。
 */
function parseServerTime(value: string): number | null {
  if (!value) return null
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)
  const ms = Date.parse(hasZone ? value : `${value}Z`)
  return Number.isNaN(ms) ? null : ms
}

/**
 * 净化服务端下发的文件名：去掉路径分隔符、控制字符与 Windows 保留字符，并截断长度。
 *
 * 服务端给的名字不可信（可能是 `../../x.md`）——这里是缓存落盘前的最后一道。
 */
function sanitizeFileName(name: string): string {
  const base = basename(name)
    .split('')
    .filter((ch) => ch.charCodeAt(0) > 31 && ch !== '\\' && !'/:*?"<>|'.includes(ch))
    .join('')
    .trim()
  const safe = base && base !== '.' && base !== '..' ? base : 'file'
  return safe.length > CACHE_NAME_MAX_LEN ? safe.slice(0, CACHE_NAME_MAX_LEN) : safe
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function mapKb(raw: unknown): CloudKbSummary {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    name: str(item.name),
    description: str(item.description),
    docsCount: num(item.docs_count),
    chunksCount: num(item.chunks_count),
    sizeDisplay: str(item.size_display),
    visibility: item.visibility === 'public' ? 'public' : 'private',
    isOwner: item.is_owner !== false,
    ownerName: typeof item.owner_name === 'string' ? item.owner_name : null,
    access:
      item.access === 'owner' || item.access === 'write' || item.access === 'read'
        ? item.access
        : undefined,
    updatedAt: str(item.updated_at)
  }
}

function mapShare(raw: unknown): CloudShareEntry {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    shareId: str(item.id),
    kbId: str(item.kb_id),
    kbName: str(item.kb_name) || str(item.kb_id),
    ownerName: str(item.nickname) || str(item.username),
    permission: item.permission === 'write' ? 'write' : 'read',
    status: str(item.status),
    expiresAt: typeof item.expires_at === 'string' ? item.expires_at : null,
    createdAt: str(item.created_at)
  }
}

function mapDoc(raw: unknown): CloudDocSummary {
  const item = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(item.id),
    name: str(item.name),
    type: str(item.type),
    sizeDisplay: str(item.size_display),
    status: str(item.status),
    chunksCount: num(item.chunks_count),
    folder: typeof item.folder === 'string' ? item.folder : null,
    uploadedAt: str(item.uploaded_at),
    indexedAt: typeof item.indexed_at === 'string' ? item.indexed_at : null,
    errorMessage:
      typeof item.error_message === 'string'
        ? item.error_message
        : typeof item.parse_warning === 'string'
          ? item.parse_warning
          : null
  }
}
