// 知识库 API 服务
import instance, {
  ApiError,
  extractErrorMessage,
  getAccessToken,
  getStreamToken,
} from './request'
import type {
  KB,
  KBDoc,
  DocChunk,
  CreateKBRequest,
  SearchOutcome,
  SearchResult,
  SearchParams,
  IndexConfig,
  KBVisibility,
  KBShare,
  KBShareListResponse,
  BatchDocResult,
  CreateDocsResult,
  DocSkip,
  PasteTextRequest,
  UrlImportRequest,
  KBGroup,
  KBShareLink,
  KBShareLinkCreated,
  KBShareLinkPreview,
  ShareExpiresIn,
} from '@/types/knowledgeBase'

// ─── 后端原始类型 ──────────────────────────────────────────────────────────

interface RawKB {
  id: string
  name: string
  description: string
  status: string
  docs_count: number
  chunks_count: number
  entities_count: number
  relations_count: number
  size_bytes: number
  size_display: string
  tags: string[]
  config: Record<string, unknown>
  created_at: string
  updated_at: string
  visibility?: string
  is_owner?: boolean
  owner_name?: string | null
  access?: string
  is_pinned?: boolean
  sort_order?: number
  group_id?: string | null
}

interface RawDoc {
  id: string
  name: string
  type: string
  size_display: string
  status: string
  progress: number
  chunks_count: number
  entities_count: number
  relations_count: number
  uploaded_at: string
  indexed_at: string | null
  error_message: string | null
  graph_error?: string | null
  parse_warning?: string | null
  stages: { name: string; status: string; pct: number }[]
  config: Record<string, unknown> | null
}

interface PaginatedData<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

// ─── 字段映射 ─────────────────────────────────────────────────────────────

function mapConfig(raw: Record<string, unknown>): IndexConfig {
  return {
    chunkStrategy: ((raw.chunk_strategy as string) || 'recursive') as IndexConfig['chunkStrategy'],
    chunkSize: (raw.chunk_size as number) || 512,
    chunkOverlap: (raw.chunk_overlap as number) || 64,
    parentChunkSize: (raw.parent_chunk_size as number) || 1536,
    minChunkSize: (raw.min_chunk_size as number) ?? 32,
    enableQueryRewrite: (raw.enable_query_rewrite as boolean) ?? false,
    enableHyde: (raw.enable_hyde as boolean) ?? false,
    embeddingModel: (raw.embedding_model as string) || 'text-embedding-v4',
    embeddingProviderId: (raw.embedding_provider_id as string) || '',
    embeddingDim: (raw.embedding_dim as number) || 1024,
    sparseAlgo: ((raw.sparse_algo as string) || 'bm25') as IndexConfig['sparseAlgo'],
    bm25K1: (raw.bm25_k1 as number) || 1.5,
    bm25B: (raw.bm25_b as number) || 0.75,
    entityModel: (raw.entity_model as string) || 'deepseek-v3',
    relationModel: (raw.relation_model as string) || 'deepseek-v3',
    enableGraph: (raw.enable_graph as boolean) ?? true,
    rerankerModel: (raw.reranker_model as string) || '',
    rerankerProviderId: (raw.reranker_provider_id as string) || '',
    enableReranker: (raw.enable_reranker as boolean) ?? false,
    topK: (raw.top_k as number) || 5,
    hybridAlpha: (raw.hybrid_alpha as number) || 0.7,
    // 门槛：0.53 是后端校准后的默认值，旧配置里没有这两个键时按它兜底
    minSimilarity: (raw.min_similarity as number) ?? 0.53,
    scoreThreshold: (raw.score_threshold as number) ?? 0,
    maxChunksPerDoc: (raw.max_chunks_per_doc as number) ?? 3,
    dedupSimilarity: (raw.dedup_similarity as number) ?? 0.92,
    // OCR 默认关闭：旧配置里没有这三个键，按关闭兜底
    enableOcr: (raw.enable_ocr as boolean) ?? false,
    ocrModel: (raw.ocr_model as string) || '',
    ocrProviderId: (raw.ocr_provider_id as string) || '',
  }
}

function mapKB(raw: RawKB): KB {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    status: raw.status as KB['status'],
    docs: raw.docs_count,
    chunks: raw.chunks_count,
    entities: raw.entities_count,
    relations: raw.relations_count,
    size: raw.size_display,
    updatedAt: raw.updated_at?.split('T')[0] || '',
    config: mapConfig(raw.config || {}),
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: raw.tags || [],
    visibility: (raw.visibility as KB['visibility']) || 'private',
    // 后端缺省视为本人所有（创建/更新接口的返回体即此语义）
    isOwner: raw.is_owner ?? true,
    ownerName: raw.owner_name ?? null,
    access: (raw.access as KB['access']) ?? undefined,
    isPinned: raw.is_pinned ?? false,
    sortOrder: raw.sort_order ?? 0,
    groupId: raw.group_id ?? null,
  }
}

function mapDoc(raw: RawDoc): KBDoc {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type as KBDoc['type'],
    size: raw.size_display,
    status: raw.status as KBDoc['status'],
    // 后端在上传响应里可能缺这些字段（旧版本只有 7 个字段），兜底为 0
    // 以免进度条渲染出 NaN
    progress: raw.progress ?? 0,
    chunks: raw.chunks_count ?? 0,
    entities: raw.entities_count ?? 0,
    relations: raw.relations_count ?? 0,
    uploadedAt: raw.uploaded_at?.split('T')[0] || '',
    errorMessage: raw.error_message || null,
    graphError: raw.graph_error || null,
    parseWarning: raw.parse_warning || null,
    stages: (raw.stages || []) as KBDoc['stages'],
    config: raw.config ? mapConfig(raw.config as Record<string, unknown>) : null,
  }
}

// ─── 知识库 CRUD ──────────────────────────────────────────────────────────

/** 列表可见范围：personal 我创建的 | public 公共库 | shared_with_me 分享给我 | all 全部可见 */
export type KBListScope = 'personal' | 'public' | 'shared_with_me' | 'all'

export interface KBPage {
  items: KB[]
  total: number
  page: number
  page_size: number
}

export async function fetchKBPage(params?: {
  page?: number
  page_size?: number
  search?: string
  scope?: KBListScope
  /** 按标签精确筛选某一个标签（迭代 6 T6.2） */
  tag?: string
  /** 按自定义分组筛选 */
  group_id?: string
}): Promise<KBPage> {
  const res = await instance.get('/knowledge-bases', { params })
  const data = res.data.data as PaginatedData<RawKB>
  return { ...data, items: data.items.map(mapKB) }
}

export async function fetchKnowledgeBases(params?: {
  page?: number
  page_size?: number
  search?: string
  scope?: KBListScope
}): Promise<KB[]> {
  const page = await fetchKBPage(params)
  return page.items
}

export async function fetchKnowledgeBase(id: string): Promise<KB | null> {
  const res = await instance.get(`/knowledge-bases/${id}`)
  const raw = res.data.data as RawKB
  return raw ? mapKB(raw) : null
}

export async function createKnowledgeBase(data: CreateKBRequest): Promise<KB> {
  const payload = { ...data, config: configToSnake(data.config) }
  const res = await instance.post('/knowledge-bases', payload)
  return mapKB(res.data.data as RawKB)
}

export async function updateKnowledgeBase(
  id: string,
  patch: Partial<KB>,
): Promise<KB> {
  const payload: Record<string, unknown> = { ...patch }
  if (payload.config) {
    payload.config = configToSnake(payload.config as IndexConfig)
  }
  const res = await instance.put(`/knowledge-bases/${id}`, payload)
  return mapKB(res.data.data as RawKB)
}

/** 置顶 / 取消置顶（只影响本人的列表顺序） */
export async function pinKnowledgeBase(id: string, pinned: boolean): Promise<KB> {
  const res = await instance.post(`/knowledge-bases/${id}/pin`, { pinned })
  return mapKB(res.data.data as RawKB)
}

/** 在列表里上移 / 下移一位（只在同一置顶分组内交换） */
export async function moveKnowledgeBase(id: string, direction: 'up' | 'down'): Promise<KB> {
  const res = await instance.post(`/knowledge-bases/${id}/move`, { direction })
  return mapKB(res.data.data as RawKB)
}

/** 复制知识库（只复制定义与配置，不复制文档与向量） */
export async function copyKnowledgeBase(id: string, name?: string): Promise<KB> {
  const res = await instance.post(`/knowledge-bases/${id}/copy`, { name })
  return mapKB(res.data.data as RawKB)
}

/** 把知识库归入分组；`group_id` 传 null 表示移出分组 */
export async function assignKbGroup(id: string, groupId: string | null): Promise<KB> {
  const res = await instance.put(`/knowledge-bases/${id}/group`, { group_id: groupId })
  return mapKB(res.data.data as RawKB)
}

// ─── 分组（用户私有）──────────────────────────────────────────────────────

function mapGroup(raw: Record<string, unknown>): KBGroup {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    sortOrder: (raw.sort_order as number) ?? 0,
    kbCount: (raw.kb_count as number) ?? 0,
  }
}

export async function fetchKbGroups(): Promise<KBGroup[]> {
  const res = await instance.get('/knowledge-base-groups')
  return (res.data.data as Record<string, unknown>[]).map(mapGroup)
}

export async function createKbGroup(name: string): Promise<KBGroup> {
  const res = await instance.post('/knowledge-base-groups', { name })
  return mapGroup(res.data.data as Record<string, unknown>)
}

export async function renameKbGroup(id: string, name: string): Promise<KBGroup> {
  const res = await instance.put(`/knowledge-base-groups/${id}`, { name })
  return mapGroup(res.data.data as Record<string, unknown>)
}

export async function deleteKbGroup(id: string): Promise<boolean> {
  const res = await instance.delete(`/knowledge-base-groups/${id}`)
  return res.data.code === 0
}

/** 导出知识库的配置 JSON（不含文档内容） */
export async function exportKnowledgeBaseConfig(id: string): Promise<Record<string, unknown>> {
  const res = await instance.get(`/knowledge-bases/${id}/export`)
  return res.data.data as Record<string, unknown>
}

/** 把导出的配置存成文件（走 fetch + Blob，与文档下载同理） */
export async function downloadKnowledgeBaseConfig(id: string, name: string): Promise<void> {
  const payload = await exportKnowledgeBaseConfig(id)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name || id}.kb-config.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function deleteKnowledgeBase(id: string): Promise<boolean> {
  const res = await instance.delete(`/knowledge-bases/${id}`)
  return res.data.code === 0
}

// ─── 统计 ─────────────────────────────────────────────────────────────────

export interface KBStatsResponse {
  totalKbs: number
  totalDocs: number
  totalChunks: number
  totalEntities: number
  indexing: number
}

export async function fetchStats(scope: 'personal' | 'all' = 'personal'): Promise<KBStatsResponse> {
  const res = await instance.get('/knowledge-bases/stats', { params: { scope } })
  const d = res.data.data as { total_kbs: number; total_docs: number; total_chunks: number; total_entities: number; total_indexing: number }
  return {
    totalKbs: d.total_kbs,
    totalDocs: d.total_docs,
    totalChunks: d.total_chunks,
    totalEntities: d.total_entities,
    indexing: d.total_indexing,
  }
}

// ─── 分享 / 可见范围 ──────────────────────────────────────────────────────

interface RawShare {
  id: string
  kb_id: string
  kb_name?: string | null
  user_id: string
  username: string | null
  nickname: string
  avatar: string
  status: string
  permission: string
  created_at: string
  accepted_at: string | null
  expires_at?: string | null
}

function mapShare(raw: RawShare): KBShare {
  return {
    id: raw.id,
    kbId: raw.kb_id,
    kbName: raw.kb_name ?? null,
    userId: raw.user_id,
    username: raw.username ?? null,
    nickname: raw.nickname || raw.username || raw.user_id,
    avatar: raw.avatar || '',
    status: raw.status as KBShare['status'],
    permission: raw.permission || 'read',
    expiresAt: (raw.expires_at as string) ?? null,
    createdAt: raw.created_at,
    acceptedAt: raw.accepted_at ?? null,
  }
}

function mapShareList(data: unknown): KBShareListResponse {
  const d = data as { items?: RawShare[]; total?: number }
  const items = (d.items || []).map(mapShare)
  return { items, total: d.total ?? items.length }
}

/** 邀请用户浏览知识库（仅所有者，只读授权） */
export async function createKbShares(
  kbId: string,
  userIds: string[],
  options?: { permission?: 'read' | 'write'; expiresIn?: ShareExpiresIn },
): Promise<KBShareListResponse> {
  const res = await instance.post(`/knowledge-bases/${kbId}/shares`, {
    user_ids: userIds,
    permission: options?.permission ?? 'read',
    expires_in: options?.expiresIn ?? 'never',
  })
  return mapShareList(res.data.data)
}

// ─── 链接式分享（迭代 6 T6.3）─────────────────────────────────────────────

function mapShareLink(raw: Record<string, unknown>): KBShareLink {
  return {
    id: String(raw.id ?? ''),
    permission: String(raw.permission ?? 'read'),
    expiresAt: (raw.expires_at as string) ?? null,
    revokedAt: (raw.revoked_at as string) ?? null,
    acceptCount: (raw.accept_count as number) ?? 0,
    lastAcceptedAt: (raw.last_accepted_at as string) ?? null,
    createdAt: String(raw.created_at ?? ''),
    state: (raw.state as KBShareLink['state']) ?? 'active',
  }
}

/** 创建链接（响应里的 token 是**唯一一次**明文，之后无法取回） */
export async function createShareLink(
  kbId: string,
  options: { permission?: 'read' | 'write'; expiresIn?: ShareExpiresIn },
): Promise<KBShareLinkCreated> {
  const res = await instance.post(`/knowledge-bases/${kbId}/share-links`, {
    permission: options.permission ?? 'read',
    expires_in: options.expiresIn ?? 'never',
  })
  const raw = res.data.data as Record<string, unknown>
  return {
    id: String(raw.id ?? ''),
    token: String(raw.token ?? ''),
    path: String(raw.path ?? ''),
    permission: String(raw.permission ?? 'read'),
    expiresAt: (raw.expires_at as string) ?? null,
  }
}

export async function fetchShareLinks(kbId: string): Promise<KBShareLink[]> {
  const res = await instance.get(`/knowledge-bases/${kbId}/share-links`)
  return (res.data.data as Record<string, unknown>[]).map(mapShareLink)
}

/** 撤销链接：只关闭"再拉新人"的入口，**已接受的人保留访问权** */
export async function revokeShareLink(kbId: string, linkId: string): Promise<void> {
  await instance.delete(`/knowledge-bases/${kbId}/share-links/${linkId}`)
}

/**
 * 免登录预览。
 *
 * **刻意不走 axios 实例**：实例的拦截器会注入 token，并在 401 时触发刷新/登出流程——
 * 而这里是匿名接口，一个过期的本地 token 不该把用户踢去登录页。用裸 fetch 保持
 * "不带凭证、也不触发鉴权流程"。
 */
export async function previewShareLink(token: string): Promise<KBShareLinkPreview> {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(
    `${baseURL}/knowledge-bases/shares/links/${encodeURIComponent(token)}/preview`,
    { headers: { Accept: 'application/json' } },
  )
  const body = (await response.json().catch(() => null)) as {
    code?: number; data?: Record<string, unknown>; message?: string
  } | null
  if (!response.ok || !body || body.code !== 0 || !body.data) {
    throw new Error(body?.message || '分享链接不存在或已失效')
  }
  const raw = body.data
  return {
    valid: Boolean(raw.valid),
    kbName: String(raw.kb_name ?? ''),
    description: String(raw.description ?? ''),
    docsCount: (raw.docs_count as number) ?? 0,
    chunksCount: (raw.chunks_count as number) ?? 0,
    ownerName: (raw.owner_name as string) ?? null,
    permission: String(raw.permission ?? 'read'),
    expiresAt: (raw.expires_at as string) ?? null,
  }
}

/** 登录后接受链接（幂等；后端会落成一条普通的已接受分享行） */
export async function acceptShareLink(
  token: string,
): Promise<{ accepted: boolean; already: boolean; permission: string }> {
  const res = await instance.post(
    `/knowledge-bases/shares/links/${encodeURIComponent(token)}/accept`,
  )
  const raw = res.data.data as Record<string, unknown>
  return {
    accepted: Boolean(raw.accepted),
    already: Boolean(raw.already),
    permission: String(raw.permission ?? 'read'),
  }
}

/** 列出某知识库的分享记录（仅所有者） */
export async function fetchKbShares(kbId: string): Promise<KBShareListResponse> {
  const res = await instance.get(`/knowledge-bases/${kbId}/shares`)
  return mapShareList(res.data.data)
}

/** 删除单个被分享用户（仅所有者） */
export async function deleteKbShare(kbId: string, shareId: string): Promise<void> {
  await instance.delete(`/knowledge-bases/${kbId}/shares/${shareId}`)
}

/** 取消该知识库的全部分享（仅所有者） */
export async function cancelKbShares(kbId: string): Promise<number> {
  const res = await instance.post(`/knowledge-bases/${kbId}/shares/cancel`)
  return (res.data.data as { revoked: number })?.revoked ?? 0
}

/** 「共享给我的」：已接受的分享 + 待处理的邀请 */
export async function fetchShareInvitations(): Promise<KBShareListResponse> {
  const res = await instance.get('/knowledge-bases/shares/invitations')
  return mapShareList(res.data.data)
}

/** 我分享出去的全部记录（跨知识库） */
export async function fetchSharesByMe(): Promise<KBShareListResponse> {
  const res = await instance.get('/knowledge-bases/shares/by-me')
  return mapShareList(res.data.data)
}

/** 搜索可分享的用户（仅返回 ID/用户名/昵称/头像） */
export async function searchShareCandidates(search: string): Promise<KBShare[]> {
  // 路径必须是 /shares/candidates：单段的 /share-candidates 会被后端的
  // GET /{kb_id} 吃掉（返回 404），导致候选用户列表永远为空。
  const res = await instance.get('/knowledge-bases/shares/candidates', {
    params: { search },
  })
  return (res.data.data as RawShare[]).map(mapShare)
}

/** 接受分享邀请 */
export async function acceptKbShare(shareId: string): Promise<KBShare> {
  const res = await instance.post(`/knowledge-bases/shares/${shareId}/accept`)
  return mapShare(res.data.data as RawShare)
}

/** 拒绝分享邀请 */
export async function rejectKbShare(shareId: string): Promise<KBShare> {
  const res = await instance.post(`/knowledge-bases/shares/${shareId}/reject`)
  return mapShare(res.data.data as RawShare)
}

/** 发布 / 取消发布公共知识库（仅所有者） */
export async function updateKbVisibility(kbId: string, visibility: KBVisibility): Promise<KB> {
  const res = await instance.patch(`/knowledge-bases/${kbId}/visibility`, { visibility })
  return mapKB(res.data.data as RawKB)
}

// ─── 文档管理 ─────────────────────────────────────────────────────────────

/** 后端返回的跳过项（snake）→ 前端形状（camel） */
function mapSkip(raw: Record<string, unknown>): DocSkip {
  return {
    name: String(raw.name ?? ''),
    reason: String(raw.reason ?? ''),
    existingDocId: (raw.existing_doc_id as string) ?? null,
    existingDocName: (raw.existing_doc_name as string) ?? null,
    existingDocStatus: (raw.existing_doc_status as string) ?? null,
  }
}

/** 创建类入口的响应形状（上传 / 粘贴 / URL 导入三者一致） */
function mapCreateResult(raw: unknown): CreateDocsResult {
  const data = (raw ?? {}) as {
    created?: RawDoc[]
    skipped?: Record<string, unknown>[]
  }
  return {
    created: (data.created ?? []).map(mapDoc),
    skipped: (data.skipped ?? []).map(mapSkip),
  }
}

/**
 * 上传**一个**文件，可订阅上传进度。
 *
 * 一次一个文件而不是一次一坨：只有这样才能给出**逐文件**的进度与成败
 * （后端本来就收文件列表，传一个也照收）。代价是请求数变多，由调用方的并发池
 * 与后端 `kb_upload` 限流一起兜住。
 *
 * `timeout: 0` 是必须的：全局 axios 超时是 15s，大文件在慢网下必然超过——而那时
 * **后端其实已经落盘并入队**，前端却报"上传失败"，是最恶劣的一类假失败。
 */
export async function uploadDocument(
  kbId: string,
  file: File,
  config?: IndexConfig,
  onProgress?: (percent: number) => void,
): Promise<CreateDocsResult> {
  const formData = new FormData()
  formData.append('files', file)
  if (config) {
    formData.append('config', JSON.stringify(configToSnake(config)))
  }
  const res = await instance.post(
    `/knowledge-bases/${kbId}/documents/upload`,
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0,
      onUploadProgress: (event) => {
        // 到 100% 只代表**请求体发完**，后端还要落盘/建行/入队
        if (onProgress && event.total) {
          onProgress(Math.round((event.loaded / event.total) * 100))
        }
      },
    },
  )
  return mapCreateResult(res.data.data)
}

/** 粘贴文本建文档——后端会落成 `.md` 后走同一条索引流水线 */
export async function createTextDocument(
  kbId: string,
  payload: PasteTextRequest,
): Promise<CreateDocsResult> {
  const res = await instance.post(`/knowledge-bases/${kbId}/documents/text`, {
    name: payload.name,
    content: payload.content,
    config: payload.config ? configToSnake(payload.config) : undefined,
  })
  return mapCreateResult(res.data.data)
}

/** URL / 网页导入（后端自带 SSRF 防护；未配置白名单时返回 code 501 与配置指引） */
export async function importFromUrl(
  kbId: string,
  payload: UrlImportRequest,
): Promise<CreateDocsResult> {
  const res = await instance.post(`/knowledge-bases/${kbId}/documents/url`, {
    url: payload.url,
    config: payload.config ? configToSnake(payload.config) : undefined,
  })
  return mapCreateResult(res.data.data)
}

/** 批量删除或重试文档——**部分成功是正常结果**，逐项报告 */
export async function batchDocumentOp(
  kbId: string,
  action: 'delete' | 'retry',
  docIds: string[],
): Promise<BatchDocResult> {
  const res = await instance.post(`/knowledge-bases/${kbId}/documents/batch`, {
    action,
    doc_ids: docIds,
  })
  const data = res.data.data as {
    action: string
    items: { doc_id: string; ok: boolean; message?: string | null; doc?: RawDoc | null }[]
    succeeded: number
    failed: number
  }
  return {
    action: data.action,
    succeeded: data.succeeded ?? 0,
    failed: data.failed ?? 0,
    items: (data.items ?? []).map((item) => ({
      docId: item.doc_id,
      ok: item.ok,
      message: item.message ?? null,
      doc: item.doc ? mapDoc(item.doc) : null,
    })),
  }
}

/** 从错误响应里抠可读文案：优先 FastAPI 的 `detail`，其次统一信封的 `message` */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; message?: unknown }
    const text = body?.detail ?? body?.message
    if (typeof text === 'string' && text) return text
  } catch {
    // 响应不是 JSON（网关错误页等），落到下面的兜底文案
  }
  return `请求失败（HTTP ${response.status}）`
}

/**
 * 从 axios 错误里抠可读文案。
 *
 * 取文案的实现已下沉到响应拦截器（`request.ts` 的 `extractErrorMessage`）——拦截器
 * 现在要弹全局提示，而它若自己不看 `response.data.detail`，弹出的就是
 * "Request failed with status code 413"；两处各写一份必然分叉，所以这里委托过去。
 *
 * 这个函数继续保留：知识库模块有 12 处调用点用它把错误渲染成**行内**文案（或配
 * 自己的上下文措辞），与全局弹窗是两种用途。
 */
export function readApiError(err: unknown): string {
  return extractErrorMessage(err)
}

/**
 * 下载文档原文。
 *
 * 用原生 `fetch` 而不是 axios 实例：响应拦截器会判响应体的 `code`，而 Blob 没有
 * 这个字段、会被一律 reject；也不能用 `<a href>` 直链——JWT 在 Authorization
 * 头里，`<a>` 天然带不上。
 */
export async function downloadDocument(
  kbId: string,
  docId: string,
  name: string,
): Promise<void> {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(
    `${baseURL}/knowledge-bases/${kbId}/documents/${docId}/download`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
    },
  )
  if (!response.ok) {
    throw new Error(await readErrorDetail(response))
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name || docId
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/**
 * 构造索引进度 SSE 地址（token 走查询参数，因为 EventSource 不能设置请求头）。
 *
 * 无 token 时返回 null，调用方应回退到轮询。
 */
export function buildIndexingStreamUrl(kbId: string): string | null {
  const token = getStreamToken()
  if (!token) return null
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  return `${baseURL}/knowledge-bases/${kbId}/indexing/stream?token=${encodeURIComponent(token)}`
}

export async function fetchDocuments(
  kbId: string,
  params?: { page?: number; page_size?: number; search?: string; status?: string },
): Promise<PaginatedData<KBDoc>> {
  const res = await instance.get(`/knowledge-bases/${kbId}/documents`, { params })
  const data = res.data.data as PaginatedData<RawDoc>
  return { ...data, items: data.items.map(mapDoc) }
}

/** 取消文档的索引任务（排队中或执行中均可） */
export async function cancelDocument(kbId: string, docId: string): Promise<KBDoc> {
  const res = await instance.post(
    `/knowledge-bases/${kbId}/documents/${docId}/cancel`,
  )
  return mapDoc(res.data.data as RawDoc)
}

export async function fetchDocument(
  kbId: string,
  docId: string,
): Promise<KBDoc> {
  const res = await instance.get(`/knowledge-bases/${kbId}/documents/${docId}`)
  return mapDoc(res.data.data as RawDoc)
}

export async function deleteDocument(
  kbId: string,
  docId: string,
): Promise<boolean> {
  const res = await instance.delete(`/knowledge-bases/${kbId}/documents/${docId}`)
  return res.data.code === 0
}

export async function retryDocument(
  kbId: string,
  docId: string,
): Promise<KBDoc> {
  const res = await instance.post(`/knowledge-bases/${kbId}/documents/${docId}/retry`)
  return mapDoc(res.data.data as RawDoc)
}

// ─── 知识图谱 ─────────────────────────────────────────────────────────────

export interface GraphDataResponse {
  entities: { id: string; name: string; type: string; mentions: number }[]
  relations: { id: string; from: string; to: string; label: string; weight: number }[]
}

export async function fetchGraphData(
  kbId: string,
  entityType?: string,
): Promise<GraphDataResponse> {
  const res = await instance.get(`/knowledge-bases/${kbId}/graph`, {
    params: entityType ? { entity_type: entityType } : {},
  })
  const raw = res.data.data as {
    entities: { id: string; name: string; type: string; mentions: number }[]
    relations: {
      id: string
      from_key: string
      to_key: string
      from_entity: string
      to_entity: string
      label: string
      weight: number
    }[]
  }
  return {
    entities: raw.entities || [],
    // 边挂到**归一键**上（与节点 id 同一个值），不再走 `source_entity_id`：
    // 那是另一套分组下的 min()，与节点 id 对不上时前端会把整条边静默丢掉。
    relations: (raw.relations || []).map((r) => ({
      id: r.id,
      from: r.from_key || r.from_entity,
      to: r.to_key || r.to_entity,
      label: r.label,
      weight: r.weight,
    })),
  }
}

/** 实体详情——比图谱列表多出「来源文档」，那是点开一个节点最想知道的事。 */
export interface EntityDetail {
  /** 归一键（与图谱节点的 id 同一个值） */
  id: string
  name: string
  type: string
  /** 提到该实体的文档数 */
  mentions: number
  sourceText: string | null
  documents: { id: string; name: string }[]
  relations: { id: string; from: string; to: string; label: string; weight: number }[]
}

export async function fetchEntityDetail(
  kbId: string,
  entityKey: string,
): Promise<EntityDetail | null> {
  let res
  try {
    res = await instance.get(
      `/knowledge-bases/${kbId}/graph/entities/${encodeURIComponent(entityKey)}`,
    )
  } catch (e) {
    // 响应拦截器对**任何非零 code 都会 reject**（request.ts），所以后端的
    // `code: 404`（实体不存在）是以异常形式到达的，根本走不到下面的响应体判断。
    // 把它收敛成 null：实体不存在是正常结果（比如刚被重抽掉了），不是错误。
    if (e instanceof ApiError && String(e.code) === '404') return null
    throw e
  }
  if (!res.data.data) return null
  const raw = res.data.data as {
    id: string
    name: string
    type: string
    mentions: number
    source_text: string | null
    documents?: { id: string; name: string }[]
    relations?: {
      id: string
      from_key: string
      to_key: string
      from_entity: string
      to_entity: string
      label: string
      weight: number
    }[]
  }
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    mentions: raw.mentions,
    sourceText: raw.source_text,
    documents: raw.documents || [],
    relations: (raw.relations || []).map((r) => ({
      id: r.id,
      from: r.from_key || r.from_entity,
      to: r.to_key || r.to_entity,
      label: r.label,
      weight: r.weight,
    })),
  }
}

export async function reExtractGraph(kbId: string): Promise<{ entities: number; relations: number; docs_processed: number }> {
  const res = await instance.post(`/knowledge-bases/${kbId}/graph/re-extract`, null, {
    timeout: 600000,  // LLM 抽取耗时较长，10 分钟超时
  })
  return res.data.data as { entities: number; relations: number; docs_processed: number }
}

// ─── 索引活动 ─────────────────────────────────────────────────────────────

export async function fetchIndexingActivity(
  kbId: string,
  limit: number = 5,
): Promise<KBDoc[]> {
  const res = await instance.get(`/knowledge-bases/${kbId}/indexing-activity`, {
    params: { limit },
  })
  return (res.data.data as RawDoc[]).map(mapDoc)
}

// ─── 可用模型 & 提供商 ───────────────────────────────────────────────────

export interface AvailableModel {
  id: string
  name: string
  display_name: string
  type: string
  provider_id?: string
}

export async function fetchAvailableModels(
  type: string = 'llm',
  providerId?: string,
): Promise<AvailableModel[]> {
  const res = await instance.get('/knowledge-bases/available-models', {
    params: { model_type: type, ...(providerId ? { provider_id: providerId } : {}) },
  })
  return res.data.data as AvailableModel[]
}

export interface AvailableProvider {
  id: string
  name: string
  logo: string
  models: AvailableModel[]
}

export async function fetchAvailableProviders(
  modelType: string = 'llm',
): Promise<AvailableProvider[]> {
  // notify：这个接口的失败此前是**静默**的——调用方（索引配置表单、建库对话框）
  // 都在 catch 里把下拉置空，于是用户只看到"没有可选的模型"，不知道是接口挂了
  // 还是模型页真的没配。置空是合理的降级，但必须说出来。
  const res = await instance.get('/knowledge-bases/available-providers', {
    params: { model_type: modelType },
    notify: true,
  })
  return res.data.data as AvailableProvider[]
}

function configToSnake(config: IndexConfig): Record<string, unknown> {
  return {
    chunk_strategy: config.chunkStrategy,
    chunk_size: config.chunkSize,
    chunk_overlap: config.chunkOverlap,
    parent_chunk_size: config.parentChunkSize,
    min_chunk_size: config.minChunkSize,
    enable_query_rewrite: config.enableQueryRewrite,
    enable_hyde: config.enableHyde,
    embedding_model: config.embeddingModel,
    embedding_provider_id: config.embeddingProviderId || null,
    embedding_dim: config.embeddingDim,
    sparse_algo: config.sparseAlgo,
    bm25_k1: config.bm25K1,
    bm25_b: config.bm25B,
    entity_model: config.entityModel,
    relation_model: config.relationModel,
    enable_graph: config.enableGraph,
    reranker_model: config.rerankerModel,
    reranker_provider_id: config.rerankerProviderId || null,
    enable_reranker: config.enableReranker,
    top_k: config.topK,
    hybrid_alpha: config.hybridAlpha,
    // 检索门槛与去冗余（迭代 2/3 新增）——不带上会在保存配置时被后端按默认值覆盖
    min_similarity: config.minSimilarity,
    score_threshold: config.scoreThreshold,
    max_chunks_per_doc: config.maxChunksPerDoc,
    dedup_similarity: config.dedupSimilarity,
    // OCR（迭代 6 T6.4）——同上，不带会被后端按默认值（关闭）覆盖
    enable_ocr: config.enableOcr,
    ocr_model: config.ocrModel,
    ocr_provider_id: config.ocrProviderId || null,
  }
}

export interface ReindexResult {
  /** 已重新入队的文档数 */
  reindexed: number
  /** 向量集合是否重建成功——为 false 时旧向量已不可用，需要处理 */
  collectionReady: boolean
}

export async function reindexKnowledgeBase(
  kbId: string,
  config: IndexConfig,
): Promise<ReindexResult> {
  const res = await instance.post(`/knowledge-bases/${kbId}/reindex`, configToSnake(config), {
    timeout: 600000,
  })
  const d = (res.data.data ?? {}) as { reindexed?: number; collection_ready?: boolean }
  return {
    reindexed: d.reindexed ?? 0,
    collectionReady: d.collection_ready ?? true,
  }
}

export async function searchKnowledgeBase(
  kbId: string,
  query: string,
  mode: string,
  topK: number = 5,
  params: SearchParams = {},
): Promise<SearchOutcome> {
  const res = await instance.post(`/knowledge-bases/${kbId}/search`, {
    query,
    mode,
    top_k: topK,
    // 未传的项由后端按「知识库配置 > 系统默认」解析
    alpha: params.alpha,
    min_similarity: params.minSimilarity,
    score_threshold: params.scoreThreshold,
    enable_rerank: params.enableRerank,
    max_chunks_per_doc: params.maxChunksPerDoc,
    dedup_similarity: params.dedupSimilarity,
    doc_ids: params.docIds,
    doc_types: params.docTypes,
    use_rewrite: params.useRewrite,
    use_hyde: params.useHyde,
  })
  const data = res.data.data as {
    results: {
      id: string
      doc_id: string
      doc_name: string
      content: string
      chunk_index: number
      score: number
      score_kind?: string
      vec_score: number | null
      bm25_score: number | null
      page: number | null
      section?: string
      kb_id?: string
      kb_name?: string
      parent_expanded?: boolean
    }[]
    rerank_requested?: boolean
    rerank_applied?: boolean
    no_relevant_result?: boolean
    min_similarity?: number | null
    filtered_count?: number
    deduped_count?: number
    searched_kb_ids?: string[]
    rewrite_requested?: boolean
    rewrite_applied?: boolean
    rewrite_queries?: string[]
    rewrite_hyde?: boolean
    rewrite_reason?: string
  }
  return {
    results: (data.results || []).map((r) => ({
      id: r.id,
      docId: r.doc_id,
      doc: r.doc_name,
      chunk: r.content,
      chunkIndex: r.chunk_index,
      score: r.score,
      scoreKind: (r.score_kind || '') as SearchResult['scoreKind'],
      // 原始分可能是 0（真实值），因此用 ?? 而不是 || 兜底
      vec: r.vec_score ?? null,
      bm25: r.bm25_score ?? null,
      page: r.page ?? null,
      section: r.section || '',
      kbId: r.kb_id || '',
      kbName: r.kb_name || '',
      parentExpanded: r.parent_expanded ?? false,
    })),
    rerankRequested: data.rerank_requested ?? false,
    rerankApplied: data.rerank_applied ?? false,
    noRelevantResult: data.no_relevant_result ?? false,
    minSimilarity: data.min_similarity ?? null,
    filteredCount: data.filtered_count ?? 0,
    dedupedCount: data.deduped_count ?? 0,
    searchedKbIds: data.searched_kb_ids ?? [],
    rewriteRequested: data.rewrite_requested ?? false,
    rewriteApplied: data.rewrite_applied ?? false,
    rewriteQueries: data.rewrite_queries ?? [],
    rewriteHyde: data.rewrite_hyde ?? false,
    rewriteReason: data.rewrite_reason || '',
  }
}

// ─── 切片管理 ─────────────────────────────────────────────────────────────

interface RawChunk {
  id: string
  index: number
  content: string
  token_count: number
  char_count: number
  page_ref: string
  section: string
  entities: string[]
}

function mapChunk(raw: RawChunk): DocChunk {
  return {
    id: raw.id,
    index: raw.index,
    content: raw.content,
    tokenCount: raw.token_count,
    charCount: raw.char_count,
    pageRef: raw.page_ref || '',
    section: raw.section || '',
    entities: raw.entities || [],
    edited: false,
  }
}

export async function fetchDocumentChunks(
  kbId: string,
  docId: string,
  search?: string,
): Promise<DocChunk[]> {
  const res = await instance.get(
    `/knowledge-bases/${kbId}/documents/${docId}/chunks`,
    { params: search ? { search } : {} },
  )
  return (res.data.data as RawChunk[]).map(mapChunk)
}

export async function fetchChunkDetail(
  kbId: string,
  docId: string,
  chunkId: string,
): Promise<{ chunk: DocChunk; prevChunk: DocChunk | null; nextChunk: DocChunk | null }> {
  const res = await instance.get(
    `/knowledge-bases/${kbId}/documents/${docId}/chunks/${chunkId}`,
  )
  const d = res.data.data as {
    chunk: RawChunk
    prev_chunk: RawChunk | null
    next_chunk: RawChunk | null
  }
  return {
    chunk: mapChunk(d.chunk),
    prevChunk: d.prev_chunk ? mapChunk(d.prev_chunk) : null,
    nextChunk: d.next_chunk ? mapChunk(d.next_chunk) : null,
  }
}

export async function updateChunkContent(
  kbId: string,
  docId: string,
  chunkId: string,
  content: string,
): Promise<DocChunk> {
  const res = await instance.put(
    `/knowledge-bases/${kbId}/documents/${docId}/chunks/${chunkId}`,
    { content },
  )
  return mapChunk(res.data.data as RawChunk)
}

export async function deleteChunk(
  kbId: string,
  docId: string,
  chunkId: string,
): Promise<boolean> {
  const res = await instance.delete(
    `/knowledge-bases/${kbId}/documents/${docId}/chunks/${chunkId}`,
  )
  return res.data.code === 0
}

export async function batchChunkOp(
  kbId: string,
  docId: string,
  action: 'save_all' | 'delete',
  params?: { chunks?: { id: string; content: string }[]; chunkIds?: string[] },
): Promise<{ saved: number; deleted: number }> {
  const body: Record<string, unknown> = { action }
  if (action === 'save_all' && params?.chunks) {
    body.chunks = params.chunks.map((c) => ({ id: c.id, content: c.content }))
  }
  if (action === 'delete' && params?.chunkIds) {
    body.chunk_ids = params.chunkIds
  }
  const res = await instance.post(
    `/knowledge-bases/${kbId}/documents/${docId}/chunks/batch`,
    body,
  )
  return res.data.data as { saved: number; deleted: number }
}
