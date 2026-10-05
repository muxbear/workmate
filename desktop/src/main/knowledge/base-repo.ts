import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { KnowledgeBaseRow, KnowledgeKind } from './types'

/**
 * 知识库仓储（R5：KnowledgeStore 拆 Repository 第二刀，纯搬移）。
 *
 * - SQL 与表结构（knowledge_bases）逐字未动；行映射器 toBase 随迁；
 * - KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）；
 * - 跨表聚合（refreshBaseStats / recountBaseIndex / stats）暂留 store —— 待
 *   DocumentRepo / ChunkVectorRepo 落位后再迁（它们同时读多张表）。
 */

interface BaseDbRow {
  id: string
  user_id: string
  name: string
  description: string
  kind: string
  status: string
  docs_count: number
  size_bytes: number
  sort_order: number
  pinned: number
  chunks_count: number
  entities_count: number
  indexed_docs_count: number
  last_indexed_at: number | null
  created_at: number
  updated_at: number
}

function toBase(row: BaseDbRow): KnowledgeBaseRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    kind: row.kind as KnowledgeKind,
    status: row.status,
    docsCount: row.docs_count,
    sizeBytes: row.size_bytes,
    // 迁移前的历史行为 0 / 未置顶，读取时兜底
    sortOrder: row.sort_order ?? 0,
    pinned: row.pinned === 1,
    chunksCount: row.chunks_count ?? 0,
    entitiesCount: row.entities_count ?? 0,
    indexedDocsCount: row.indexed_docs_count ?? 0,
    lastIndexedAt: row.last_indexed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class BaseRepo {
  constructor(private readonly getDb: () => Database.Database) {}

  listBases(
    userId: string,
    opts: { kind?: KnowledgeKind; keyword?: string } = {}
  ): KnowledgeBaseRow[] {
    const db = this.getDb()
    const conditions = ['user_id = ?']
    const params: unknown[] = [userId]
    if (opts.kind) {
      conditions.push('kind = ?')
      params.push(opts.kind)
    }
    if (opts.keyword && opts.keyword.trim()) {
      conditions.push('(name LIKE ? OR description LIKE ?)')
      const like = `%${opts.keyword.trim()}%`
      params.push(like, like)
    }
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_bases WHERE ${conditions.join(' AND ')} ORDER BY pinned DESC, sort_order ASC, updated_at DESC, rowid DESC`
      )
      .all(...params) as BaseDbRow[]
    return rows.map(toBase)
  }

  getBase(userId: string, id: string): KnowledgeBaseRow | null {
    const row = this.getDb()
      .prepare('SELECT * FROM knowledge_bases WHERE id = ? AND user_id = ?')
      .get(id, userId) as BaseDbRow | undefined
    return row ? toBase(row) : null
  }

  findBaseByName(userId: string, name: string): KnowledgeBaseRow | null {
    const row = this.getDb()
      .prepare('SELECT * FROM knowledge_bases WHERE user_id = ? AND name = ?')
      .get(userId, name) as BaseDbRow | undefined
    return row ? toBase(row) : null
  }

  createBase(
    userId: string,
    input: { name: string; description: string; kind: KnowledgeKind }
  ): KnowledgeBaseRow {
    const db = this.getDb()
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_bases (id, user_id, name, description, kind, status, docs_count, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ready', 0, 0, ?, ?)`
    ).run(id, userId, input.name, input.description, input.kind, now, now)
    return {
      id,
      userId,
      name: input.name,
      description: input.description,
      kind: input.kind,
      status: 'ready',
      docsCount: 0,
      sizeBytes: 0,
      // 新建的知识库排在同分类未置顶区的最前面（sort_order 与其他未拖拽项一致时按更新时间兜底）
      sortOrder: 0,
      pinned: false,
      chunksCount: 0,
      entitiesCount: 0,
      indexedDocsCount: 0,
      lastIndexedAt: null,
      createdAt: now,
      updatedAt: now
    }
  }

  updateBase(userId: string, id: string, patch: { name?: string; description?: string }): void {
    const db = this.getDb()
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      params.push(patch.description)
    }
    sets.push('updated_at = ?')
    params.push(Date.now())
    params.push(id, userId)
    db.prepare(`UPDATE knowledge_bases SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...params
    )
  }

  /**
   * 拖拽排序：按传入顺序把某分类下的知识库写回 sort_order（0 起，越小越靠前）。
   * 只影响传进来的 id，其余行保持原值。
   */
  reorderBases(userId: string, kind: KnowledgeKind, orderedIds: string[]): number {
    const db = this.getDb()
    const stmt = db.prepare(
      'UPDATE knowledge_bases SET sort_order = ? WHERE id = ? AND user_id = ? AND kind = ?'
    )
    let changed = 0
    db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        changed += stmt.run(index, id, userId, kind).changes
      })
    })(orderedIds)
    return changed
  }

  /**
   * 置顶 / 取消置顶。
   *
   * - 置顶：sort_order 取同分类置顶组最小值之前，保证它是置顶区第一条；
   * - 取消置顶：保留当前 sort_order，于是落到未置顶区的最前面。
   */
  setBasePinned(userId: string, id: string, pinned: boolean): void {
    const db = this.getDb()
    const row = db
      .prepare('SELECT kind FROM knowledge_bases WHERE id = ? AND user_id = ?')
      .get(id, userId) as { kind: string } | undefined
    if (!row) return
    if (!pinned) {
      db.prepare('UPDATE knowledge_bases SET pinned = 0 WHERE id = ? AND user_id = ?').run(
        id,
        userId
      )
      return
    }
    const head = db
      .prepare(
        'SELECT MIN(sort_order) AS value FROM knowledge_bases WHERE user_id = ? AND kind = ? AND pinned = 1'
      )
      .get(userId, row.kind) as { value: number | null }
    const next = (head.value ?? 0) - 1
    db.prepare(
      'UPDATE knowledge_bases SET pinned = 1, sort_order = ? WHERE id = ? AND user_id = ?'
    ).run(next, id, userId)
  }

  deleteBase(userId: string, id: string): number {
    const db = this.getDb()
    return db.prepare('DELETE FROM knowledge_bases WHERE id = ? AND user_id = ?').run(id, userId)
      .changes
  }
}
