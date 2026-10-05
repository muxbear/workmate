/**
 * 知识库领域类型（主进程内部 + IPC 返回值）
 *
 * 说明：本阶段只落地「知识库管理 + 文件落盘」，
 * 索引相关字段（status / index_state）先按最终形态建表，
 * 取值在索引能力落地前恒为 none / 只上传文件。
 */

// 与 IPC 契约逐字一致的类型统一从 shared/contracts 复用（契约单一来源，避免两份定义漂移）
import type { KnowledgeKind, KnowledgeIndexState, KnowledgeDocStatus, KnowledgeIndexStage, KnowledgeHit, RetrievalDebugStage, KnowledgeGraphViewLink, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeStats, KnowledgeIndexProgress, KnowledgeSearchResult, RetrievalDebugChannelStat, RetrievalDebugInfo, KnowledgeGraphViewNode, KnowledgeDocumentMeta, KnowledgeImportResult } from '../../shared/contracts'
export type { KnowledgeKind, KnowledgeIndexState, KnowledgeDocStatus, KnowledgeIndexStage, KnowledgeHit, RetrievalDebugStage, KnowledgeGraphViewLink, KnowledgeGraphView, KnowledgeImportOutcome, KnowledgeStats, KnowledgeIndexProgress, KnowledgeSearchResult, RetrievalDebugChannelStat, RetrievalDebugInfo, KnowledgeGraphViewNode, KnowledgeDocumentMeta, KnowledgeImportResult }
// 同名异义复核（2026-10-05）：以下 7 型与契约逐行一致，统一复用

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

export type KnowledgeSearchMode = 'hybrid' | 'vector' | 'bm25'

/**
 * 检索侧对话历史（多轮改写用：代词式追问「它的缺点呢」靠它补全指代）。
 * 只喂给查询改写器，不改写原文第一路，也不直接进检索词。
 */
export interface RetrievalHistoryTurn {
  role: 'user' | 'assistant'
  content: string
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

/** 导入条目：源文件绝对路径 + 目标相对路径（保留上传时的目录结构） */
export interface KnowledgeImportItem {
  srcPath: string
  relPath: string
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
