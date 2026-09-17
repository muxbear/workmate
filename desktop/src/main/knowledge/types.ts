/**
 * 知识库领域类型（主进程内部 + IPC 返回值）
 *
 * 说明：本阶段只落地「知识库管理 + 文件落盘」，
 * 索引相关字段（status / index_state）先按最终形态建表，
 * 取值在索引能力落地前恒为 none / 只上传文件。
 */

/** 知识库来源分组：本地创建 / 他人共享 / 云端 */
export type KnowledgeKind = 'local' | 'shared' | 'cloud'

/** 文档索引状态（对应列表里的「已建立索引 / 自定义索引 / 未索引」） */
export type KnowledgeIndexState = 'none' | 'default' | 'custom'

/** 文档处理状态；索引管线落地前恒为 none */
export type KnowledgeDocStatus = 'none' | 'queued' | 'indexing' | 'indexed' | 'failed'

/** 知识库行（IPC 直接返回，字段名为 camelCase） */
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
  uploadedAt: number
  updatedAt: number
}

/** 渲染层可见的文档元信息（不含 storage_path / user_id / hash） */
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
  uploadedAt: number
  updatedAt: number
}

/** 导入条目：源文件绝对路径 + 目标相对路径（保留上传时的目录结构） */
export interface KnowledgeImportItem {
  srcPath: string
  relPath: string
}

/** 单个文件的导入结果 */
export interface KnowledgeImportOutcome {
  name: string
  relPath: string
  reason: string
}

/** 导入汇总 */
export interface KnowledgeImportResult {
  /** 成功落盘的文档 */
  accepted: KnowledgeDocumentMeta[]
  /** 主动跳过（重复、超批次等） */
  skipped: KnowledgeImportOutcome[]
  /** 失败（超大小、源文件不可读等） */
  failed: KnowledgeImportOutcome[]
}

/** 概览统计（切片/实体统计随索引能力提供，这里先给出文件维度） */
export interface KnowledgeStats {
  kbCount: number
  docCount: number
  sizeBytes: number
  latestUpdatedAt: number
}

/** 共享记录 */
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
