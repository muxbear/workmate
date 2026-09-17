import { mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type {
  KnowledgeBaseRow,
  KnowledgeDocStatus,
  KnowledgeDocumentRow,
  KnowledgeIndexState,
  KnowledgeKind,
  KnowledgeShareRow,
  KnowledgeStats
} from './types'

/** 索引库文件名（位于「知识库设置 → 本地存储」目录内） */
export const INDEX_DB_FILE = 'index.db'

/**
 * 索引库迁移：独立版本序列，与 ke-work.db 无关。
 *
 * 本阶段只建「知识库 / 文档 / 共享」三张表；切片、向量、图谱与 FTS5 表
 * 随索引能力一并加入（见 docs/桌面版知识库实现方案.md 第九章）。
 */
const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'kb_baseline',
    sql: `
CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'local',
  status      TEXT NOT NULL DEFAULT 'ready',
  docs_count  INTEGER NOT NULL DEFAULT 0,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_user_name ON knowledge_bases(user_id, name);
CREATE INDEX IF NOT EXISTS idx_kb_user_kind ON knowledge_bases(user_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_base_documents (
  id            TEXT PRIMARY KEY,
  kb_id         TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  rel_path      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  index_state   TEXT NOT NULL DEFAULT 'none',
  status        TEXT NOT NULL DEFAULT 'none',
  content_hash  TEXT,
  error_message TEXT,
  uploaded_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kd_kb_relpath ON knowledge_base_documents(kb_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_kd_kb_updated ON knowledge_base_documents(kb_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kd_kb_hash ON knowledge_base_documents(kb_id, content_hash);

CREATE TABLE IF NOT EXISTS knowledge_shares (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  target_name TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'view',
  expires_at  INTEGER,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ks_user ON knowledge_shares(user_id, created_at DESC);
`
  },
  {
    version: 2,
    name: 'kb_sort_and_pin',
    sql: `
ALTER TABLE knowledge_bases ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_kb_user_pin_order ON knowledge_bases(user_id, pinned DESC, sort_order ASC);
`
  }
]

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
  created_at: number
  updated_at: number
}

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
  uploaded_at: number
  updated_at: number
}

interface ShareDbRow {
  id: string
  user_id: string
  target_kind: string
  target_id: string
  target_name: string
  token: string
  permission: string
  expires_at: number | null
  revoked_at: number | null
  created_at: number
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
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
    uploadedAt: row.uploaded_at,
    updatedAt: row.updated_at
  }
}

function toShare(row: ShareDbRow): KnowledgeShareRow {
  return {
    id: row.id,
    userId: row.user_id,
    targetKind: row.target_kind as KnowledgeShareRow['targetKind'],
    targetId: row.target_id,
    targetName: row.target_name,
    token: row.token,
    url: `ke-work://share/${row.token}`,
    permission: row.permission,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  }
}

/**
 * 知识库索引库（<knowledge.directory>/index.db）
 *
 * - **独立于 ke-work.db**：知识库是可重定位的独立存储（换目录即换一套库），
 *   且后续切片/向量数据会显著撑大主库（主库还承载 LangGraph checkpoint）。
 * - **目录可变**：目录来自「知识库设置 → 本地存储」，构造时注入 getter；
 *   每次访问前比对目录，变化时关闭旧库、打开新库（旧库不迁移，与设置页语义一致）。
 * - 运行期主进程内存以外的一切读写都经这里，渲染层不接触绝对路径。
 */
export class KnowledgeStore {
  private db: Database.Database | null = null
  private openedDir = ''
  private readonly getDir: () => string

  constructor(getDir: () => string) {
    this.getDir = getDir
  }

  /** 当前索引库文件路径（目录未创建时先创建） */
  getDbPath(): string {
    return join(this.getDir(), INDEX_DB_FILE)
  }

  /** 惰性打开（目录变化时自动换库） */
  private open(): Database.Database {
    const dir = this.getDir()
    if (this.db && this.openedDir === dir) return this.db
    this.close()
    mkdirSync(dir, { recursive: true })
    const db = new Database(join(dir, INDEX_DB_FILE))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    this.runMigrations(db)
    this.db = db
    this.openedDir = dir
    return db
  }

  /** 关闭连接（切换目录/退出时调用） */
  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } catch (err) {
      console.warn('[knowledge-store] close failed:', err)
    }
    this.db = null
    this.openedDir = ''
  }

  /** 版本化迁移：按 kb_meta.schema_version 增量应用 */
  private runMigrations(db: Database.Database): void {
    db.exec('CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = db.prepare("SELECT value FROM kb_meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined
    let current = row ? Number(row.value) || 0 : 0
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      db.exec(migration.sql)
      current = migration.version
      db.prepare(
        "INSERT INTO kb_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(current))
      console.log(`[knowledge-store] applied migration ${migration.name} (v${current})`)
    }
  }

  // ── 知识库 ──

  listBases(
    userId: string,
    opts: { kind?: KnowledgeKind; keyword?: string } = {}
  ): KnowledgeBaseRow[] {
    const db = this.open()
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
    const row = this.open()
      .prepare('SELECT * FROM knowledge_bases WHERE id = ? AND user_id = ?')
      .get(id, userId) as BaseDbRow | undefined
    return row ? toBase(row) : null
  }

  findBaseByName(userId: string, name: string): KnowledgeBaseRow | null {
    const row = this.open()
      .prepare('SELECT * FROM knowledge_bases WHERE user_id = ? AND name = ?')
      .get(userId, name) as BaseDbRow | undefined
    return row ? toBase(row) : null
  }

  createBase(
    userId: string,
    input: { name: string; description: string; kind: KnowledgeKind }
  ): KnowledgeBaseRow {
    const db = this.open()
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
      createdAt: now,
      updatedAt: now
    }
  }

  updateBase(userId: string, id: string, patch: { name?: string; description?: string }): void {
    const db = this.open()
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
    const db = this.open()
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
    const db = this.open()
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
    const db = this.open()
    return db.prepare('DELETE FROM knowledge_bases WHERE id = ? AND user_id = ?').run(id, userId)
      .changes
  }

  /** 重算某知识库的文件数与占用（增删文档后调用） */
  refreshBaseStats(kbId: string): void {
    const db = this.open()
    const agg = db
      .prepare(
        'SELECT COUNT(*) AS docs, COALESCE(SUM(size_bytes), 0) AS size FROM knowledge_base_documents WHERE kb_id = ?'
      )
      .get(kbId) as { docs: number; size: number }
    db.prepare('UPDATE knowledge_bases SET docs_count = ?, size_bytes = ? WHERE id = ?').run(
      agg.docs,
      agg.size,
      kbId
    )
  }

  // ── 文档 ──

  listDocuments(userId: string, kbId: string): KnowledgeDocumentRow[] {
    const rows = this.open()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? ORDER BY rel_path COLLATE NOCASE ASC'
      )
      .all(kbId, userId) as DocDbRow[]
    return rows.map(toDocument)
  }

  findDocument(userId: string, kbId: string, relPath: string): KnowledgeDocumentRow | null {
    const row = this.open()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? AND rel_path = ?'
      )
      .get(kbId, userId, relPath) as DocDbRow | undefined
    return row ? toDocument(row) : null
  }

  /** 按文件夹前缀取文档（含子层级；relPath 为空表示整库） */
  listDocumentsByPrefix(userId: string, kbId: string, prefix: string): KnowledgeDocumentRow[] {
    if (!prefix) return this.listDocuments(userId, kbId)
    const rows = this.open()
      .prepare(
        'SELECT * FROM knowledge_base_documents WHERE kb_id = ? AND user_id = ? AND (rel_path = ? OR rel_path LIKE ?)'
      )
      .all(kbId, userId, prefix, `${prefix}/%`) as DocDbRow[]
    return rows.map(toDocument)
  }

  /** 同库同内容哈希命中（文件去重）；excludeId 用于自身更新场景 */
  findDocumentByHash(kbId: string, hash: string, excludeId?: string): KnowledgeDocumentRow | null {
    const rows = this.open()
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
  }): KnowledgeDocumentRow {
    const db = this.open()
    const { id } = input
    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_base_documents
        (id, kb_id, user_id, name, type, size_bytes, rel_path, storage_path, index_state, status, content_hash, error_message, uploaded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, NULL, ?, ?)`
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
      input.contentHash,
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
      status: 'none',
      contentHash: input.contentHash,
      errorMessage: null,
      uploadedAt: now,
      updatedAt: now
    }
  }

  /** 更新文档的名称/相对路径（重命名；storage_path 不变，磁盘按 docId 隔离） */
  updateDocumentPath(id: string, patch: { name?: string; relPath?: string }): void {
    const db = this.open()
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
    const db = this.open()
    const stmt = db.prepare('DELETE FROM knowledge_base_documents WHERE id = ?')
    db.transaction((list: string[]) => {
      for (const id of list) stmt.run(id)
    })(ids)
  }

  stats(userId: string): KnowledgeStats {
    const db = this.open()
    const base = db
      .prepare('SELECT COUNT(*) AS kbs FROM knowledge_bases WHERE user_id = ?')
      .get(userId) as { kbs: number }
    const docs = db
      .prepare(
        `SELECT COUNT(*) AS docs, COALESCE(SUM(size_bytes), 0) AS size, COALESCE(MAX(updated_at), 0) AS latest
         FROM knowledge_base_documents WHERE user_id = ?`
      )
      .get(userId) as { docs: number; size: number; latest: number }
    return {
      kbCount: base.kbs,
      docCount: docs.docs,
      sizeBytes: docs.size,
      latestUpdatedAt: docs.latest
    }
  }

  // ── 共享 ──

  insertShare(input: {
    userId: string
    targetKind: KnowledgeShareRow['targetKind']
    targetId: string
    targetName: string
    permission: string
    expiresAt: number | null
  }): KnowledgeShareRow {
    const db = this.open()
    const id = randomUUID()
    const token = randomUUID().replace(/-/g, '')
    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_shares
        (id, user_id, target_kind, target_id, target_name, token, permission, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      id,
      input.userId,
      input.targetKind,
      input.targetId,
      input.targetName,
      token,
      input.permission,
      input.expiresAt,
      now
    )
    return {
      id,
      userId: input.userId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      targetName: input.targetName,
      token,
      url: `ke-work://share/${token}`,
      permission: input.permission,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: now
    }
  }

  listShares(userId: string): KnowledgeShareRow[] {
    const rows = this.open()
      .prepare(
        'SELECT * FROM knowledge_shares WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
      )
      .all(userId) as ShareDbRow[]
    return rows.map(toShare)
  }

  /** 撤销共享：返回受影响行数（0 = 不存在或非本人） */
  revokeShare(userId: string, token: string): number {
    return this.open()
      .prepare(
        'UPDATE knowledge_shares SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL'
      )
      .run(Date.now(), token, userId).changes
  }

  /** 删除某知识库下的全部共享记录（删库时清理） */
  deleteSharesForTarget(userId: string, targetId: string): void {
    this.open()
      .prepare('DELETE FROM knowledge_shares WHERE user_id = ? AND target_id = ?')
      .run(userId, targetId)
  }
}
