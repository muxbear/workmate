import type Database from 'better-sqlite3'
import type {
  KnowledgeDocStatus,
  KnowledgeDocumentRow,
  KnowledgeIndexStage,
  KnowledgeIndexState
} from './types'

/**
 * 文档仓储（R5：KnowledgeStore 拆 Repository 第三刀，纯搬移）。
 *
 * - SQL 与表结构（knowledge_base_documents）逐字未动；行映射器 toDocument 随迁；
 * - KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）；
 * - 跨表聚合（stats / refreshBaseStats / recountBaseIndex）暂留 store，待
 *   ChunkVectorRepo 落位后再迁（它们同时读多张表）。
 */

interface DocDbRow {
  id: string
  kb_id: string
  user_id: string
  name: string
  type: string
  size_bytes: number
  rel_path: string
  storage_path: string
  index_state: string
  status: string
  content_hash: string | null
  error_message: string | null
  progress: number
  stage: string | null
  char_count: number
  truncated: number
  config: string | null
  chunks_count: number
  entities_count: number
  relations_count: number
  graph_error: string | null
  index_signature: string | null
  indexed_at: number | null
  uploaded_at: number
  updated_at: number
}

function toDocument(row: DocDbRow): KnowledgeDocumentRow {
  return {
    id: row.id,
    kbId: row.kb_id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    sizeBytes: row.size_bytes,
    relPath: row.rel_path,
    storagePath: row.storage_path,
    indexState: row.index_state as KnowledgeIndexState,
    status: row.status as KnowledgeDocStatus,
    contentHash: row.content_hash,
    errorMessage: row.error_message,
    // v4 之前的旧行没有这些列的值，统一兜底
    progress: row.progress ?? 0,
    stage: (row.stage as KnowledgeIndexStage | null) ?? null,
    charCount: row.char_count ?? 0,
    truncated: row.truncated === 1,
    config: row.config ?? null,
    chunksCount: row.chunks_count ?? 0,
    entitiesCount: row.entities_count ?? 0,
    relationsCount: row.relations_count ?? 0,
    graphError: row.graph_error ?? null,
    indexSignature: row.index_signature ?? null,
    indexedAt: row.indexed_at ?? null,
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at
  }
}

export class DocumentRepo {
  constructor(private readonly getDb: () => Database.Database) {}

  listDocuments(userId: string, kbId: string): KnowledgeDocumentRow[] {
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? ORDER BY rel_path COLLATE NOCASE ASC'
      )
      .all(kbId, userId) as DocDbRow[]
    return rows.map(toDocument)
  }

  findDocument(userId: string, kbId: string, relPath: string): KnowledgeDocumentRow | null {
    const row = this.getDb()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? AND rel_path = ?'
      )
      .get(kbId, userId, relPath) as DocDbRow | undefined
    return row ? toDocument(row) : null
  }

  /** 按文档 ID 取行（索引队列按 docId 驱动，需要拿 storage_path 与快照） */
  getDocumentById(id: string): KnowledgeDocumentRow | null {
    const row = this.getDb()
      .prepare('SELECT * FROM knowledge_base_documents WHERE id = ?')
      .get(id) as DocDbRow | undefined
    return row ? toDocument(row) : null
  }

  /** 按文件夹前缀取文档（含子层级；relPath 为空表示整库） */
  listDocumentsByPrefix(userId: string, kbId: string, prefix: string): KnowledgeDocumentRow[] {
    if (!prefix) return this.listDocuments(userId, kbId)
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? AND (rel_path = ? OR rel_path LIKE ?)'
      )
      .all(kbId, userId, prefix, `${prefix}/%`) as DocDbRow[]
    return rows.map(toDocument)
  }

  /** 同库同内容哈希命中（文件去重）；excludeId 用于自身更新场景 */
  findDocumentByHash(kbId: string, hash: string, excludeId?: string): KnowledgeDocumentRow | null {
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND content_hash = ? LIMIT 5'
      )
      .all(kbId, hash) as DocDbRow[]
    for (const row of rows) {
      if (excludeId && row.id === excludeId) continue
      return toDocument(row)
    }
    return null
  }

  insertDocument(input: {
    /** 文档 ID 由调用方生成（先落盘再写库，磁盘目录以 ID 隔离） */
    id: string
    kbId: string
    userId: string
    name: string
    type: string
    sizeBytes: number
    relPath: string
    storagePath: string
    indexState: KnowledgeIndexState
    contentHash: string | null
    /** 本次导入的 14 项索引配置快照（JSON；仅上传文件时为 null） */
    config?: string | null
    /** 需要建索引时传 'queued'，仅上传文件保持 'none' */
    status?: KnowledgeDocStatus
  }): KnowledgeDocumentRow {
    const db = this.getDb()
    const { id } = input
    const now = Date.now()
    const status: KnowledgeDocStatus = input.status ?? 'none'
    db.prepare(
      `INSERT INTO knowledge_base_documents
        (id, kb_id, user_id, name, type, size_bytes, rel_path, storage_path, index_state, status, content_hash, config, error_message, uploaded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(
      id,
      input.kbId,
      input.userId,
      input.name,
      input.type,
      input.sizeBytes,
      input.relPath,
      input.storagePath,
      input.indexState,
      status,
      input.contentHash,
      input.config ?? null,
      now,
      now
    )
    return {
      id,
      kbId: input.kbId,
      userId: input.userId,
      name: input.name,
      type: input.type,
      sizeBytes: input.sizeBytes,
      relPath: input.relPath,
      storagePath: input.storagePath,
      indexState: input.indexState,
      status,
      contentHash: input.contentHash,
      errorMessage: null,
      progress: 0,
      stage: status === 'queued' ? 'queued' : null,
      charCount: 0,
      truncated: false,
      config: input.config ?? null,
      chunksCount: 0,
      entitiesCount: 0,
      relationsCount: 0,
      graphError: null,
      indexSignature: null,
      indexedAt: null,
      uploadedAt: now,
      updatedAt: now
    }
  }

  /** 更新文档的名称/相对路径（重命名；storage_path 不变，磁盘按 docId 隔离） */
  updateDocumentPath(id: string, patch: { name?: string; relPath?: string }): void {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [Date.now()]
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.relPath !== undefined) {
      sets.push('rel_path = ?')
      params.push(patch.relPath)
    }
    params.push(id)
    db.prepare(`UPDATE knowledge_base_documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  deleteDocuments(ids: string[]): void {
    if (!ids.length) return
    const db = this.getDb()
    const stmt = db.prepare('DELETE FROM knowledge_base_documents WHERE id = ?')
    db.transaction((list: string[]) => {
      for (const id of list) stmt.run(id)
    })(ids)
  }

  /** 索引进度回写（「先写库、后推事件」的写库侧） */
  updateDocumentIndexState(
    id: string,
    patch: {
      status?: KnowledgeDocStatus
      stage?: KnowledgeIndexStage | null
      progress?: number
      charCount?: number
      truncated?: boolean
      chunksCount?: number
      entitiesCount?: number
      relationsCount?: number
      errorMessage?: string | null
      graphError?: string | null
      indexSignature?: string | null
      indexedAt?: number | null
    }
  ): void {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [Date.now()]
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.stage !== undefined) push('stage', patch.stage)
    if (patch.progress !== undefined) push('progress', patch.progress)
    if (patch.charCount !== undefined) push('char_count', patch.charCount)
    if (patch.truncated !== undefined) push('truncated', patch.truncated ? 1 : 0)
    if (patch.chunksCount !== undefined) push('chunks_count', patch.chunksCount)
    if (patch.entitiesCount !== undefined) push('entities_count', patch.entitiesCount)
    if (patch.relationsCount !== undefined) push('relations_count', patch.relationsCount)
    if (patch.errorMessage !== undefined) push('error_message', patch.errorMessage)
    if (patch.graphError !== undefined) push('graph_error', patch.graphError)
    if (patch.indexSignature !== undefined) push('index_signature', patch.indexSignature)
    if (patch.indexedAt !== undefined) push('indexed_at', patch.indexedAt)
    params.push(id)
    db.prepare(`UPDATE knowledge_base_documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  /** 更新文档的索引配置快照（重建时以当前生效配置刷新，保证「改设置再重建」生效） */
  updateDocumentConfig(id: string, config: string): void {
    this.getDb()
      .prepare('UPDATE knowledge_base_documents SET config = ?, updated_at = ? WHERE id = ?')
      .run(config, Date.now(), id)
  }

  /** 启动恢复：把中断残留的 queued/indexing 置为 failed（应用退出中断） */
  recoverInterruptedIndexing(): number {
    const db = this.getDb()
    const now = Date.now()
    return db
      .prepare(
        `UPDATE knowledge_base_documents
         SET status = 'failed', stage = NULL, error_message = ?, updated_at = ?
         WHERE status IN ('queued', 'indexing')`
      )
      .run('应用退出中断，请重新索引', now).changes
  }
}
