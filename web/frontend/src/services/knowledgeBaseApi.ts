// 知识库 API 服务
import instance from './request'
import type {
  KB,
  KBDoc,
  DocChunk,
  CreateKBRequest,
  SearchOutcome,
  IndexConfig,
  KBVisibility,
  KBShare,
  KBShareListResponse,
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
export async function createKbShares(kbId: string, userIds: string[]): Promise<KBShareListResponse> {
  const res = await instance.post(`/knowledge-bases/${kbId}/shares`, { user_ids: userIds })
  return mapShareList(res.data.data)
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

export async function uploadDocuments(
  kbId: string,
  files: File[],
  config?: IndexConfig,
): Promise<KBDoc[]> {
  const formData = new FormData()
  files.forEach((f) => formData.append('files', f))
  if (config) {
    formData.append('config', JSON.stringify(configToSnake(config)))
  }
  const res = await instance.post(
    `/knowledge-bases/${kbId}/documents/upload`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return (res.data.data as RawDoc[]).map(mapDoc)
}

export async function fetchDocuments(
  kbId: string,
  params?: { page?: number; page_size?: number; search?: string; status?: string },
): Promise<PaginatedData<KBDoc>> {
  const res = await instance.get(`/knowledge-bases/${kbId}/documents`, { params })
  const data = res.data.data as PaginatedData<RawDoc>
  return { ...data, items: data.items.map(mapDoc) }
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
  relations: { id: string; from: string; to: string; label: string; weight: number; sourceEntityId?: string; targetEntityId?: string }[]
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
    relations: { id: string; from_entity: string; to_entity: string; label: string; weight: number; source_entity_id?: string; target_entity_id?: string }[]
  }
  return {
    entities: raw.entities || [],
    relations: (raw.relations || []).map((r) => ({
      id: r.id,
      from: r.source_entity_id || r.from_entity,
      to: r.target_entity_id || r.to_entity,
      label: r.label,
      weight: r.weight,
      sourceEntityId: r.source_entity_id,
      targetEntityId: r.target_entity_id,
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
  const res = await instance.get('/knowledge-bases/available-providers', {
    params: { model_type: modelType },
  })
  return res.data.data as AvailableProvider[]
}

function configToSnake(config: IndexConfig): Record<string, unknown> {
  return {
    chunk_strategy: config.chunkStrategy,
    chunk_size: config.chunkSize,
    chunk_overlap: config.chunkOverlap,
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
  }
}

export async function reindexKnowledgeBase(
  kbId: string,
  config: IndexConfig,
): Promise<{ kb_id: string; docs_enqueued: number; status: string }> {
  const res = await instance.post(`/knowledge-bases/${kbId}/reindex`, configToSnake(config), {
    timeout: 600000,
  })
  return res.data.data as { kb_id: string; docs_enqueued: number; status: string }
}

export async function searchKnowledgeBase(
  kbId: string,
  query: string,
  mode: string,
  topK: number = 5,
): Promise<SearchOutcome> {
  const res = await instance.post(`/knowledge-bases/${kbId}/search`, {
    query,
    mode,
    top_k: topK,
  })
  const data = res.data.data as {
    results: {
      id: string
      doc_name: string
      content: string
      score: number
      vec_score: number | null
      bm25_score: number | null
    }[]
    rerank_requested?: boolean
    rerank_applied?: boolean
  }
  return {
    results: (data.results || []).map((r) => ({
      id: r.id,
      doc: r.doc_name,
      chunk: r.content,
      score: r.score,
      vec: r.vec_score ?? 0,
      bm25: r.bm25_score ?? 0,
    })),
    rerankRequested: data.rerank_requested ?? false,
    rerankApplied: data.rerank_applied ?? false,
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
