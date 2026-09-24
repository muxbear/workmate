// 知识库相关类型定义

// 知识库状态
export type KBStatus = 'ready' | 'indexing' | 'error' | 'draft'

// 文档索引状态
export type DocStatus =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'bm25'
  | 'extracting'
  | 'indexed'
  | 'failed'
  | 'canceled'

// 切片策略
export type ChunkStrategy = 'fixed' | 'recursive' | 'semantic' | 'markdown' | 'agentic'

// 稀疏检索算法
export type SparseAlgo = 'bm25' | 'bm25_plus' | 'tf_idf' | 'none'

// 文档类型
export type DocType = 'pdf' | 'md' | 'docx' | 'csv' | 'image' | 'html'

// 索引流水线阶段状态（canceled 表示用户在该阶段取消了索引）
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

// 索引配置
export interface IndexConfig {
  chunkStrategy: ChunkStrategy
  chunkSize: number
  chunkOverlap: number
  embeddingModel: string
  /** embedding 模型所属提供商（用于消解同名模型；可为空表示按名称全局解析） */
  embeddingProviderId: string
  embeddingDim: number
  sparseAlgo: SparseAlgo
  bm25K1: number
  bm25B: number
  entityModel: string
  relationModel: string
  enableGraph: boolean
  rerankerModel: string
  /** reranker 模型所属提供商；配合「模型」页 type=rerank 使用 */
  rerankerProviderId: string
  enableReranker: boolean
  topK: number
  hybridAlpha: number
  /** 最低余弦相似度——最高相似度低于该值时判定"库中没有相关内容" */
  minSimilarity: number
  /** 相对截断比例（0 表示关闭）：丢弃低于「最高分 × 该比例」的结果 */
  scoreThreshold: number
  /** 同一文档最多占用的结果条数（0 表示不限制） */
  maxChunksPerDoc: number
  /** 近重复判定阈值（0 表示关闭）：与已选结果相似度 ≥ 该值的候选被丢弃 */
  dedupSimilarity: number
}

// 索引阶段
export interface DocStage {
  name: string
  status: StageStatus
  pct: number
}

// 知识库文档
export interface KBDoc {
  id: string
  name: string
  type: DocType
  size: string
  status: DocStatus
  progress: number
  chunks: number
  entities: number
  relations: number
  uploadedAt: string
  errorMessage: string | null
  /** 图谱抽取失败原因（索引本身成功，图谱页签会因此为空） */
  graphError: string | null
  stages: DocStage[]
  config: IndexConfig | null
}

// 知识图谱实体
export interface Entity {
  id: string
  name: string
  type: string
  mentions: number
  x: number
  y: number
}

// 知识图谱关系
export interface Relation {
  id: string
  from: string
  to: string
  label: string
  weight?: number
  sourceEntityId?: string
  targetEntityId?: string
}

// 知识库
export interface KB {
  id: string
  name: string
  description: string
  status: KBStatus
  docs: number
  chunks: number
  entities: number
  relations: number
  size: string
  updatedAt: string
  config: IndexConfig
  documents: KBDoc[]
  entitiesData: Entity[]
  relationsData: Relation[]
  tags: string[]
  /** 可见范围：private 私有 | public 公共（所有人可只读浏览） */
  visibility: KBVisibility
  /** 当前登录用户是否是该知识库的所有者；false 时页面进入只读态 */
  isOwner: boolean
  /** 所有者展示名（公共库/被分享的库用于标识来源） */
  ownerName: string | null
}

// ─── 可见范围 / 分享 ──────────────────────────────────────────────────────

// 知识库可见范围
export type KBVisibility = 'private' | 'public'

// 分享状态
export type ShareStatus = 'pending' | 'accepted' | 'rejected' | 'revoked'

// 左栏栏目标识
export type KbScope = 'overview' | 'public' | 'personal' | 'sharedByMe' | 'sharedWithMe'

// 一条分享记录
export interface KBShare {
  id: string
  kbId: string
  /** 知识库名称（仅「共享给我的」场景由后端填充） */
  kbName: string | null
  userId: string
  username: string | null
  nickname: string
  avatar: string
  status: ShareStatus
  permission: string
  createdAt: string
  acceptedAt: string | null
}

export interface KBShareListResponse {
  items: KBShare[]
  total: number
}

export interface ShareStatusConfig {
  label: string
  cls: string
}

export const SHARE_STATUS_CONFIG: Record<ShareStatus, ShareStatusConfig> = {
  pending: { label: '待接受', cls: 'share-pending' },
  accepted: { label: '已接受', cls: 'share-accepted' },
  rejected: { label: '已拒绝', cls: 'share-rejected' },
  revoked: { label: '已取消', cls: 'share-revoked' },
}

// 可见范围配置
export const KB_VISIBILITY_CONFIG: Record<KBVisibility, { label: string; cls: string }> = {
  private: { label: '私有', cls: 'vis-private' },
  public: { label: '公共', cls: 'vis-public' },
}

/** 左栏每个分组的子项预览条数（超出走「查看更多」） */
export const KB_GROUP_PREVIEW_LIMIT = 8

// 知识库状态配置
export interface KBStatusConfig {
  label: string
  cls: string
}

export const KB_STATUS_CONFIG: Record<KBStatus, KBStatusConfig> = {
  ready: { label: '就绪', cls: 'status-ready' },
  indexing: { label: '索引中', cls: 'status-indexing' },
  error: { label: '错误', cls: 'status-error' },
  draft: { label: '草稿', cls: 'status-draft' },
}

// 文档状态配置
export interface DocStatusConfig {
  label: string
  cls: string
}

export const DOC_STATUS_CONFIG: Record<DocStatus, DocStatusConfig> = {
  queued: { label: '排队', cls: 'doc-status-queued' },
  parsing: { label: '解析中', cls: 'doc-status-parsing' },
  chunking: { label: '切片中', cls: 'doc-status-chunking' },
  embedding: { label: '向量化', cls: 'doc-status-embedding' },
  bm25: { label: 'BM25 倒排', cls: 'doc-status-bm25' },
  extracting: { label: '实体抽取', cls: 'doc-status-extracting' },
  indexed: { label: '已索引', cls: 'doc-status-indexed' },
  failed: { label: '失败', cls: 'doc-status-failed' },
  canceled: { label: '已取消', cls: 'doc-status-canceled' },
}

// 切片策略选项
export interface ChunkStrategyOption {
  value: ChunkStrategy
  label: string
  desc: string
}

export const CHUNK_STRATEGY_OPTIONS: ChunkStrategyOption[] = [
  { value: 'fixed', label: '固定长度', desc: '按字符数硬切，最简单' },
  { value: 'recursive', label: '递归分隔符', desc: '按段落→换行→句号递归切分' },
  { value: 'semantic', label: '语义分块', desc: '基于句子向量相似度自动切' },
  { value: 'markdown', label: 'Markdown 结构', desc: '按标题层级切分，保留结构' },
  { value: 'agentic', label: 'Agentic 智能', desc: 'LLM 判断主题边界' },
]

// Embedding 模型选项
export interface EmbeddingModelOption {
  value: string
  label: string
  dim: number
}

export const EMBEDDING_MODEL_OPTIONS: EmbeddingModelOption[] = [
  { value: 'bge-large-zh-v1.5', label: 'BGE-Large-zh v1.5', dim: 1024 },
  { value: 'bge-m3', label: 'BGE-M3 (多语言)', dim: 1024 },
  { value: 'text-embedding-3-large', label: 'OpenAI text-embedding-3-large', dim: 3072 },
  { value: 'text-embedding-3-small', label: 'OpenAI text-embedding-3-small', dim: 1536 },
  { value: 'qwen3-embedding-8b', label: 'Qwen3-Embedding-8B', dim: 4096 },
  { value: 'jina-embeddings-v3', label: 'Jina Embeddings v3', dim: 1024 },
]

export const LLM_MODEL_OPTIONS = [
  'gpt-4o',
  'gpt-4o-mini',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'qwen3-72b',
  'deepseek-v3',
  'glm-4.5',
] as const

/**
 * Reranker 模型不再硬编码：从「模型」页面 type=rerank 的模型中读取
 * （fetchAvailableProviders('rerank')），否则会出现「界面可选但后端无此模型」
 * 的假配置。
 */
export const RERANKER_MODEL_TYPE = 'rerank'

// 文档类型配置
export interface DocTypeConfig {
  label: string
  icon: string
}

export const DOC_TYPE_CONFIG: Record<DocType, DocTypeConfig> = {
  pdf: { label: 'PDF', icon: 'pdf' },
  md: { label: 'Markdown', icon: 'md' },
  docx: { label: 'Word', icon: 'docx' },
  csv: { label: 'CSV', icon: 'csv' },
  image: { label: '图片', icon: 'image' },
  html: { label: 'HTML', icon: 'html' },
}

// 检索模式
export type SearchMode = 'hybrid' | 'vector' | 'bm25'

export interface SearchModeConfig {
  label: string
  desc: string
}

export const SEARCH_MODE_CONFIG: Record<SearchMode, SearchModeConfig> = {
  hybrid: { label: '混合检索', desc: '向量 + BM25 融合' },
  vector: { label: '向量检索', desc: '稠密语义' },
  bm25: { label: 'BM25', desc: '稀疏关键词' },
}

// 分数含义：与后端 score_kind 一一对应
export type ScoreKind = 'cosine' | 'bm25' | 'rrf' | 'rerank'

export const SCORE_KIND_LABEL: Record<ScoreKind, string> = {
  cosine: '向量相似度',
  bm25: '关键词得分',
  rrf: '融合排序分',
  rerank: '精排相关度',
}

// 检索结果
export interface SearchResult {
  id: string
  docId: string
  doc: string
  chunk: string
  chunkIndex: number
  score: number
  /** score 的含义——UI 必须按它如实标注，不能一律叫"综合分" */
  scoreKind: ScoreKind | ''
  /** 原始余弦相似度 */
  vec: number | null
  /** 原始 BM25 得分 */
  bm25: number | null
  /** 引用定位：来源页码与章节 */
  page: number | null
  section: string
  /** 来源知识库（跨库检索时用于标注结果出处） */
  kbId: string
  kbName: string
}

// 检索返回：结果 + 门槛与精排的实际状态
export interface SearchOutcome {
  results: SearchResult[]
  /** 知识库配置是否要求精排 */
  rerankRequested: boolean
  /** 精排是否**实际生效**（模型不可用或调用失败时为 false） */
  rerankApplied: boolean
  /** 是否判定「库中没有相关内容」（最高相似度低于门槛，结果被清空） */
  noRelevantResult: boolean
  /** 本次生效的最低余弦门槛 */
  minSimilarity: number | null
  /** 被门槛过滤掉的条数 */
  filteredCount: number
  /** 因近重复或单文档配额被丢弃的条数（结果已由后续候选补足） */
  dedupedCount: number
  /** 实际参与检索的知识库（跨库检索时可能有库因"无相关内容"被剔除） */
  searchedKbIds: string[]
}

/** 高级检索参数（检索页可覆盖知识库配置） */
export interface SearchParams {
  alpha?: number
  minSimilarity?: number
  scoreThreshold?: number
  enableRerank?: boolean
  maxChunksPerDoc?: number
  dedupSimilarity?: number
  /** 只在指定文档内检索（文档 ID 列表） */
  docIds?: string[]
  /** 只在指定文件类型内检索，如 ['pdf', 'md'] */
  docTypes?: string[]
}

// 视图模式
export type ViewMode = 'grid' | 'list'

// 文档流水线阶段名称

// 创建知识库请求
export interface CreateKBRequest {
  name: string
  description: string
  tags: string[]
  config: IndexConfig
  visibility?: KBVisibility
}

// 文档切片
export interface DocChunk {
  id: string
  index: number
  content: string
  tokenCount: number
  charCount: number
  pageRef: string
  section: string
  entities: string[]
  edited?: boolean
}

// 上传文档请求
export interface UploadDocRequest {
  name: string
  type: DocType
  size: string
}
