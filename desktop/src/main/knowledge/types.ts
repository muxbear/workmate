/**
 * 知识库领域类型（主进程内部 + IPC 返回值）
 *
 * 说明：本阶段只落地「知识库管理 + 文件落盘」，
 * 索引相关字段（status / index_state）先按最终形态建表，
 * 取值在索引能力落地前恒为 none / 只上传文件。
 */

// 与 IPC 契约逐字一致的类型统一从 shared/contracts 复用（契约单一来源，避免两份定义漂移）
import type { KnowledgeKind, KnowledgeIndexState, KnowledgeDocStatus, KnowledgeIndexStage, KnowledgeHit, RetrievalDebugStage, KnowledgeGraphViewLink, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeStats } from '../../shared/contracts'
export type { KnowledgeKind, KnowledgeIndexState, KnowledgeDocStatus, KnowledgeIndexStage, KnowledgeHit, RetrievalDebugStage, KnowledgeGraphViewLink, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeStats }

export type KnowledgeChunkStrategy = 'semantic' | 'fixed' | 'markdown' | 'recursive'

/** 单个切片（ChunkingService 输出；charStart/charEnd 可还原原文） */
export interface KnowledgeChunk {
  index: number
  content: string
  tokenCount: number
  heading?: string
  charStart: number
  charEnd: number
}

/** 文档索引进度事件载荷（主进程 → 渲染层） */
export interface KnowledgeIndexProgress {
  kbId: string
  docId: string
  relPath: string
  status: KnowledgeDocStatus
  stage: KnowledgeIndexStage
  progress: number
  /** 本轮索引已写入的块数（进行中为 0；终态为本次写入值。渲染层按 `chunks || 现值` 保留旧值展示） */
  chunks: number
  entities: number
  relations: number
  error?: string
  /** 非致命告警（如 semantic 降级 recursive、图谱失败但文档已索引） */
  warning?: string
}

export type KnowledgeSearchMode = 'hybrid' | 'vector' | 'bm25'

/**
 * 检索侧对话历史（多轮改写用：代词式追问「它的缺点呢」靠它补全指代）。
 * 只喂给查询改写器，不改写原文第一路，也不直接进检索词。
 */
export interface RetrievalHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 检索结果（含降级标记，UI 据此轻提示） */
export interface KnowledgeSearchResult {
  hits: KnowledgeHit[]
  /** 稠密路被跳过（未配置嵌入端点或库内无向量） */
  vectorSkipped: boolean
  /** 稀疏路被跳过（sparseRetrieval=false） */
  sparseSkipped: boolean
  /** 重排被跳过（未启用或端点不可用） */
  rerankSkipped: boolean
  /** 稠密路最大相似度低于门限：视为「没有相关内容」，问答据此如实回答 */
  noRelevantResult: boolean
  /** 图扩展命中的查询实体名（graphEnabled 且命中时才有；问答据此提示「知识关联」） */
  graphEntities?: string[]
  /** 检索调试（仅 retrieve({debug:true}) 返回；页面问答与会话工具不带） */
  debug?: RetrievalDebugInfo
}

/** 检索调试：单个阶段耗时 */
export interface RetrievalDebugChannelStat {
  /** 通道内候选数（跨变体求和；门限挡掉稠密后为 0，见 denseGate） */
  candidates: number
  /** 跨变体的通道耗时（毫秒，求和） */
  ms: number
}

/** 检索调试载荷（面板据此展示各路分数/耗时；不影响正常链路） */
export interface RetrievalDebugInfo {
  mode: KnowledgeSearchMode
  topK: number
  /** 召回候选池上限（topK × 倍数） */
  candidateLimit: number
  /** 实际使用的查询（原文第一路 + 改写变体） */
  variants: string[]
  timings: RetrievalDebugStage[]
  channels: {
    sparse: RetrievalDebugChannelStat
    dense: RetrievalDebugChannelStat
    graph: RetrievalDebugChannelStat
  }
  /** 稠密门限判定（未启用门限或稠密未跑时为 null） */
  denseGate: { threshold: number; topScore: number; failed: boolean } | null
  flags: {
    vectorSkipped: boolean
    sparseSkipped: boolean
    rerankSkipped: boolean
    mmrApplied: boolean
    decayApplied: boolean
  }
  /** 融合后的候选数（合并相邻块之前） */
  fusedCount: number
  /** 命中明细（与 result.hits 对齐；附衰减系数等调试信息） */
  hits: Array<{
    chunkId: number
    score: number
    vecScore?: number
    bm25Score?: number
    source?: KnowledgeHit['source']
    uploadedAt?: number
    decayFactor?: number
  }>
}

/** 图谱可视化节点（跨文档按 name_key 折叠；mentions/docs 为聚合值） */
export interface KnowledgeGraphViewNode {
  /** 归一化实体 key（name_key） */
  key: string
  name: string
  type: string
  /** 全库出现次数（跨文档） */
  mentions: number
  /** 出现该实体的文档数（跨文档） */
  docs: number
}

export interface KnowledgeBaseRow {
  id: string
  userId: string
  name: string
  description: string
  kind: KnowledgeKind
  status: string
  docsCount: number
  sizeBytes: number
  /** 手动拖拽排序序号（同分类内越小越靠前） */
  sortOrder: number
  /** 是否置顶（置顶始终排在未置顶之前） */
  pinned: boolean
  /** 索引汇总（由切片/图谱写入后回算；索引能力落地前恒为 0） */
  chunksCount: number
  entitiesCount: number
  indexedDocsCount: number
  lastIndexedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 文档行 */
export interface KnowledgeDocumentRow {
  id: string
  kbId: string
  userId: string
  name: string
  /** 扩展名大写（PDF / DOCX / 文件） */
  type: string
  sizeBytes: number
  /** 相对知识库根目录的路径，'/' 分隔（文件树的唯一依据） */
  relPath: string
  /** 落盘绝对路径（仅主进程可见，不返回渲染层） */
  storagePath: string
  indexState: KnowledgeIndexState
  status: KnowledgeDocStatus
  contentHash: string | null
  errorMessage: string | null
  /** 索引进度 0~100 与当前阶段 */
  progress: number
  stage: KnowledgeIndexStage | null
  /** 抽取的全文长度与是否被 2MB 上限截断 */
  charCount: number
  truncated: boolean
  /** 本次导入的 14 项索引配置快照（JSON 字符串，null = 仅上传文件） */
  config: string | null
  chunksCount: number
  entitiesCount: number
  relationsCount: number
  /** 图谱抽取失败原因（文档仍 indexed；绝不静默） */
  graphError: string | null
  /** 索引口径指纹：配置变化才需要重建 */
  indexSignature: string | null
  indexedAt: number | null
  uploadedAt: number
  updatedAt: number
}

/** 渲染层可见的文档元信息（不含 storage_path / user_id / hash / config 原文） */
export interface KnowledgeDocumentMeta {
  id: string
  kbId: string
  name: string
  type: string
  sizeBytes: number
  relPath: string
  indexState: KnowledgeIndexState
  status: KnowledgeDocStatus
  errorMessage: string | null
  progress: number
  stage: KnowledgeIndexStage | null
  charCount: number
  truncated: boolean
  chunksCount: number
  entitiesCount: number
  relationsCount: number
  graphError: string | null
  indexedAt: number | null
  uploadedAt: number
  updatedAt: number
}

/** 导入条目：源文件绝对路径 + 目标相对路径（保留上传时的目录结构） */
export interface KnowledgeImportItem {
  srcPath: string
  relPath: string
}

/** 单个文件的导入结果 */
export interface KnowledgeImportResult {
  /** 成功落盘的文档 */
  accepted: KnowledgeDocumentMeta[]
  /** 主动跳过（重复、超批次等） */
  skipped: KnowledgeImportOutcome[]
  /** 失败（超大小、源文件不可读等） */
  failed: KnowledgeImportOutcome[]
}

export interface KnowledgeShareRow {
  id: string
  userId: string
  targetKind: 'library' | 'folder' | 'file'
  targetId: string
  targetName: string
  token: string
  url: string
  permission: string
  expiresAt: number | null
  revokedAt: number | null
  createdAt: number
}
