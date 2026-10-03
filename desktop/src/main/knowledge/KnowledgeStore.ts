import { mkdirSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { normalizeName } from './entity-norm'
import type {
  KnowledgeBaseRow,
  KnowledgeChunk,
  KnowledgeDocStatus,
  KnowledgeDocumentRow,
  KnowledgeIndexStage,
  KnowledgeIndexState,
  KnowledgeKind,
  KnowledgeShareRow,
  KnowledgeStats
} from './types'

/** 索引库文件名（位于「知识库设置 → 本地存储」目录内） */
export const INDEX_DB_FILE = 'index.db'

/** 某维度的向量表名（维度一表：不同库的 vectorDimensions 可以不同） */
function vectorTableName(dim: number): string {
  return `kb_chunk_vec_${dim}`
}

/** 切片稳定标识：sha1(docId:chunkIndex)，幂等重灌时同一位置得到同一 uid */
export function chunkUid(docId: string, chunkIndex: number): string {
  return createHash('sha1').update(`${docId}:${chunkIndex}`).digest('hex')
}

/** BLOB → Float32Array 视图（零拷贝） */
function toFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

/**
 * 索引库迁移：独立版本序列，与 ke-work.db 无关。
 *
 * 本阶段只建「知识库 / 文档 / 共享」三张表；切片、向量、图谱与 FTS5 表
 * 随索引能力一并加入（见 docs/桌面版知识库实现方案.md 第九章）。
 */
/** 版本化迁移表（导出供测试直接驱动；与 `SqlMigrationRunner` 导出 `MIGRATIONS_DIR` 同一做法） */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
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
  },
  {
    version: 3,
    name: 'kb_retire_cloud_kind',
    // 侧栏的「云端知识库」分组已删除（云端库改为从 Web 后端同步、不落本地库）。
    // 老数据里由那个分组创建出来的行 kind='cloud'，若原样留着会从侧栏彻底消失——
    // 用户看到的是"知识库丢了"。它们本来就是本地库，这里一次性归一为 local：
    // 渲染层不做兜底（本地组的拖拽排序要求"传入 id 集合 == 该 kind 全量"，
    // 把两批 kind 混进同一个列表会让刷新后顺序弹回）。
    sql: `
UPDATE knowledge_bases SET kind = 'local' WHERE kind = 'cloud';
`
  },
  {
    version: 4,
    name: 'kb_rag_index',
    // RAG 索引数据模型：文档进度/结果列 + 切片/图谱/缓存表。
    //
    // 注意：两张虚拟表不在这里建——
    // - kb_chunk_fts（FTS5）与 kb_chunk_vec（sqlite-vec 扩展）都由各自模块在
    //   运行时惰性创建（迁移测试跑在 node:sqlite 上，既没有 vec0 扩展，
    //   FTS5 也不保证编译进来；且 vec0 必须先加载扩展才能建表）。
    // - 两者的可用性分别记录在 kb_meta 的 fts5_ready / vector_backend。
    sql: `
ALTER TABLE knowledge_base_documents ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN stage TEXT;
ALTER TABLE knowledge_base_documents ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN config TEXT;
ALTER TABLE knowledge_base_documents ADD COLUMN chunks_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN entities_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN relations_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_base_documents ADD COLUMN graph_error TEXT;
ALTER TABLE knowledge_base_documents ADD COLUMN index_signature TEXT;
ALTER TABLE knowledge_base_documents ADD COLUMN indexed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_kd_kb_status ON knowledge_base_documents(kb_id, status);

ALTER TABLE knowledge_bases ADD COLUMN chunks_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN entities_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN indexed_docs_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN last_indexed_at INTEGER;

CREATE TABLE IF NOT EXISTS knowledge_base_chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uid             TEXT NOT NULL UNIQUE,
  kb_id           TEXT NOT NULL,
  doc_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL DEFAULT 0,
  heading         TEXT,
  char_start      INTEGER NOT NULL DEFAULT 0,
  char_end        INTEGER NOT NULL DEFAULT 0,
  embedding       BLOB,
  vector_dim      INTEGER,
  vector_model    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kc_doc_chunk ON knowledge_base_chunks(doc_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_kc_kb ON knowledge_base_chunks(kb_id, user_id);
CREATE INDEX IF NOT EXISTS idx_kc_doc ON knowledge_base_chunks(doc_id);

CREATE TABLE IF NOT EXISTS knowledge_base_entities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id        TEXT NOT NULL,
  doc_id       TEXT NOT NULL,
  chunk_id     INTEGER,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  type         TEXT NOT NULL,
  mentions     INTEGER NOT NULL DEFAULT 1,
  source_text  TEXT,
  char_start   INTEGER,
  char_end     INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_unique ON knowledge_base_entities(kb_id, name_key, type);
CREATE INDEX IF NOT EXISTS idx_ke_doc ON knowledge_base_entities(doc_id);
CREATE INDEX IF NOT EXISTS idx_ke_kb_name ON knowledge_base_entities(kb_id, name_key);

CREATE TABLE IF NOT EXISTS knowledge_base_relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id       TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  chunk_id    INTEGER,
  user_id     TEXT NOT NULL,
  from_entity TEXT NOT NULL,
  to_entity   TEXT NOT NULL,
  from_key    TEXT NOT NULL,
  to_key      TEXT NOT NULL,
  label       TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1,
  description TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kr_unique ON knowledge_base_relations(kb_id, from_key, to_key, label);
CREATE INDEX IF NOT EXISTS idx_kr_doc ON knowledge_base_relations(doc_id);
CREATE INDEX IF NOT EXISTS idx_kr_from ON knowledge_base_relations(kb_id, from_key);
CREATE INDEX IF NOT EXISTS idx_kr_to ON knowledge_base_relations(kb_id, to_key);

CREATE TABLE IF NOT EXISTS knowledge_base_communities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_id        TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  level        INTEGER NOT NULL DEFAULT 0,
  entity_keys  TEXT NOT NULL,
  summary      TEXT NOT NULL,
  entity_count INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kc_comm_kb ON knowledge_base_communities(kb_id, level);

CREATE TABLE IF NOT EXISTS knowledge_embedding_cache (
  hash       TEXT PRIMARY KEY,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`
  },
  {
    version: 5,
    name: 'kb_graph_per_document',
    // 图谱实体/关系改为**按文档存**（跨文档聚合在查询侧做）：
    // - 单文档重抽/删除只需 `DELETE ... WHERE doc_id = ?`，级联简单且不会误删
    //   其它文档里提到的同一实体；
    // - 代价是同一实体在不同文档各占一行，查询侧按 name_key 折叠、mentions 用 COUNT 聚合。
    // v4 里的 (kb_id, name_key, type) 唯一索引必须去掉，否则第二篇文档写入同名实体会冲突。
    sql: `
DROP INDEX IF EXISTS idx_ke_unique;
DROP INDEX IF EXISTS idx_kr_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_doc_unique ON knowledge_base_entities(doc_id, name_key, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kr_doc_unique ON knowledge_base_relations(doc_id, from_key, to_key, label);
CREATE INDEX IF NOT EXISTS idx_ke_kb_type ON knowledge_base_entities(kb_id, type);
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
  chunks_count: number
  entities_count: number
  indexed_docs_count: number
  last_indexed_at: number | null
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

interface ChunkDbRow {
  chunk_id: number
  uid: string
  doc_id: string
  chunk_index: number
  heading: string | null
  content: string
  char_start: number
  char_end: number
}

/** 切片 + JOIN 文档表后的命中行（docName/relPath 供引用展示） */
interface ChunkHitDbRow extends ChunkDbRow {
  doc_name: string
  rel_path: string
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
    chunksCount: row.chunks_count ?? 0,
    entitiesCount: row.entities_count ?? 0,
    indexedDocsCount: row.indexed_docs_count ?? 0,
    lastIndexedAt: row.last_indexed_at ?? null,
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

// 文档行 → 渲染层元信息的映射只有一个实现：KnowledgeFileService.toDocumentMeta

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
    this.db = db
    this.openedDir = dir
    this.runMigrations(db)
    // 稀疏索引表随库打开惰性创建（FTS5 不可用时降级并记录，不阻断其它功能）
    this.ensureSparseIndexOn(db)
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
      chunksCount: 0,
      entitiesCount: 0,
      indexedDocsCount: 0,
      lastIndexedAt: null,
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

  /** 按文档 ID 取行（索引队列按 docId 驱动，需要拿 storage_path 与快照） */
  getDocumentById(id: string): KnowledgeDocumentRow | null {
    const row = this.open()
      .prepare('SELECT * FROM knowledge_base_documents WHERE id = ?')
      .get(id) as DocDbRow | undefined
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
    /** 本次导入的 14 项索引配置快照（JSON；仅上传文件时为 null） */
    config?: string | null
    /** 需要建索引时传 'queued'，仅上传文件保持 'none' */
    status?: KnowledgeDocStatus
  }): KnowledgeDocumentRow {
    const db = this.open()
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
        `SELECT COUNT(*) AS docs, COALESCE(SUM(size_bytes), 0) AS size, COALESCE(MAX(updated_at), 0) AS latest,
                COALESCE(SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexed_docs,
                COALESCE(SUM(CASE WHEN status IN ('queued', 'indexing') THEN 1 ELSE 0 END), 0) AS indexing_docs
         FROM knowledge_base_documents WHERE user_id = ?`
      )
      .get(userId) as {
      docs: number
      size: number
      latest: number
      indexed_docs: number
      indexing_docs: number
    }
    const chunks = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_chunks WHERE user_id = ?')
      .get(userId) as { c: number }
    const entities = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE user_id = ?')
      .get(userId) as { c: number }
    return {
      kbCount: base.kbs,
      docCount: docs.docs,
      sizeBytes: docs.size,
      latestUpdatedAt: docs.latest,
      indexedDocCount: docs.indexed_docs,
      indexingDocCount: docs.indexing_docs,
      chunksCount: chunks.c,
      entitiesCount: entities.c
    }
  }

  // ── 索引元信息（kb_meta 键值）──

  getMeta(key: string): string | null {
    const row = this.open()
      .prepare('SELECT value FROM kb_meta WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  setMeta(key: string, value: string): void {
    this.open()
      .prepare(
        "INSERT INTO kb_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value)
  }

  // ── 稀疏索引（FTS5）与向量索引（sqlite-vec）──

  /**
   * 惰性创建 FTS5 稀疏索引表。
   *
   * 刻意用普通 FTS5 表（不是 contentless）：contentless 表不存储列值，
   * `kb_id/user_id` 过滤会静默匹配不到任何行（spike 实测）。这里存的是
   * 分词后的文本，原文仍以 `knowledge_base_chunks.content` 为唯一事实源。
   */
  ensureSparseIndex(): boolean {
    const db = this.open()
    return this.ensureSparseIndexOn(db)
  }

  private ensureSparseIndexOn(db: Database.Database): boolean {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(
        text_tokens, kb_id UNINDEXED, user_id UNINDEXED, tokenize='unicode61')`)
      this.setMeta('fts5_ready', '1')
      return true
    } catch (err) {
      console.warn('[knowledge-store] FTS5 不可用，稀疏检索降级：', err)
      this.setMeta('fts5_ready', '0')
      return false
    }
  }

  /**
   * 加载 sqlite-vec 扩展并自检。
   *
   * 失败不抛错（返回原因）：调用方降级为 JS 余弦，并把模式记录到 kb_meta，
   * 让设置页/日志能看到「当前向量后端是什么」。
   */
  loadVectorExtension(extPath: string): { ok: boolean; version?: string; error?: string } {
    const db = this.open()
    try {
      db.loadExtension(extPath)
      const row = db.prepare('SELECT vec_version() AS v').get() as { v: string }
      this.setMeta('vector_backend', 'sqlite-vec')
      this.setMeta('vector_version', row.v)
      return { ok: true, version: row.v }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[knowledge-store] sqlite-vec 扩展加载失败，向量检索降级为 JS 余弦：', message)
      this.setMeta('vector_backend', 'js')
      return { ok: false, error: message }
    }
  }

  /** 当前向量后端（未加载过扩展时按 js 兜底） */
  getVectorBackend(): 'sqlite-vec' | 'js' {
    return this.getMeta('vector_backend') === 'sqlite-vec' ? 'sqlite-vec' : 'js'
  }

  /** 确保某维度的向量表存在（vec0；需先 loadVectorExtension 成功）。维度一表：kb_chunk_vec_<dim> */
  ensureVectorTable(dim: number): boolean {
    if (this.getVectorBackend() !== 'sqlite-vec') return false
    if (!Number.isInteger(dim) || dim <= 0 || dim > 8192) return false
    const db = this.open()
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName(dim)} USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[${dim}],
        kb_id TEXT,
        user_id TEXT,
        doc_id TEXT
      )`)
      return true
    } catch (err) {
      console.warn(`[knowledge-store] 向量表(kb_chunk_vec_${dim})创建失败：`, err)
      return false
    }
  }

  /** 库内已建立的向量表（按维度；用于重建/删除时精确清理） */
  private listVectorTables(): string[] {
    const rows = this.open()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kb_chunk_vec_%'")
      .all() as Array<{ name: string }>
    return rows.map((row) => row.name).filter((name) => /^kb_chunk_vec_\d+$/.test(name))
  }

  // ── 索引写入（切片 + 稀疏 + 向量，单事务）──

  /**
   * 用一批切片替换某文档的全部索引数据（幂等重建的落点）。
   *
   * 单事务内完成：清旧（FTS/向量/切片/图谱）→ 插切片 → 插 FTS 行 → 写向量。
   * - 向量后端为 sqlite-vec 时写入 `kb_chunk_vec_<dim>`（chunk_id 主键必须
   *   用 BigInt 绑定：better-sqlite3 默认把 number 绑成 REAL，vec0 会拒绝）；
   * - 降级模式写入 `knowledge_base_chunks.embedding` BLOB。
   * 返回写入的切片数。
   */
  replaceDocumentIndex(input: {
    docId: string
    kbId: string
    userId: string
    chunks: KnowledgeChunk[]
    /** 与 chunks 等长的分词文本（SparseIndexer.tokenize 输出）；FTS 不可用时传 null */
    tokens: string[] | null
    /** 与 chunks 等长的向量（未向量化传 null） */
    vectors: Float32Array[] | null
    vectorDim: number | null
    vectorModel: string | null
  }): number {
    const db = this.open()
    const now = Date.now()
    const hasFts = this.getMeta('fts5_ready') === '1'
    const tokens = input.tokens
    const vectors = input.vectors
    const useVec = this.getVectorBackend() === 'sqlite-vec' && vectors !== null
    const dim = input.vectorDim
    const vecTable = useVec && dim ? vectorTableName(dim) : null

    const insertChunk = db.prepare(
      `INSERT INTO knowledge_base_chunks
        (uid, kb_id, doc_id, user_id, chunk_index, content, token_count, heading, char_start, char_end, embedding, vector_dim, vector_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // FTS 语句必须等表确认可用后再准备（FTS5 不可用的构建上预编译会直接抛错）
    const insertFts = hasFts
      ? db.prepare('INSERT INTO kb_chunk_fts(rowid, text_tokens, kb_id, user_id) VALUES (?, ?, ?, ?)')
      : null

    const run = db.transaction((): number => {
      // 1. 清旧
      this.clearDocumentIndexTx(db, input.docId)
      // 2. 插切片
      const ids: number[] = []
      input.chunks.forEach((chunk, i) => {
        const vector = input.vectors?.[i] ?? null
        const blob = vector && !useVec ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null
        const info = insertChunk.run(
          chunkUid(input.docId, chunk.index),
          input.kbId,
          input.docId,
          input.userId,
          chunk.index,
          chunk.content,
          chunk.tokenCount,
          chunk.heading ?? null,
          chunk.charStart,
          chunk.charEnd,
          blob,
          vector ? dim : null,
          vector ? input.vectorModel : null,
          now
        )
        ids.push(Number(info.lastInsertRowid))
      })
      // 3. 稀疏行
      if (insertFts && tokens) {
        ids.forEach((id, i) => insertFts.run(id, tokens[i] ?? '', input.kbId, input.userId))
      }
      // 4. 向量行（vec0 主键必须 BigInt）
      if (vecTable && vectors) {
        this.ensureVectorTable(dim as number)
        const insertVec = db.prepare(
          `INSERT INTO ${vecTable}(chunk_id, embedding, kb_id, user_id, doc_id) VALUES (?, ?, ?, ?, ?)`
        )
        ids.forEach((id, i) => {
          const vector = vectors[i]
          if (!vector) return
          insertVec.run(BigInt(id), vector, input.kbId, input.userId, input.docId)
        })
      }
      return ids.length
    })

    return run()
  }

  /** 清某文档的索引数据（切片/FTS/向量/图谱）；在事务内调用或独立调用均可 */
  private clearDocumentIndexTx(db: Database.Database, docId: string): void {
    const rows = db.prepare('SELECT id FROM knowledge_base_chunks WHERE doc_id = ?').all(docId) as Array<{
      id: number
    }>
    if (rows.length) {
      const delFts = db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?')
      for (const row of rows) delFts.run(row.id)
    }
    for (const table of this.listVectorTables()) {
      db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(docId)
    }
    db.prepare('DELETE FROM knowledge_base_chunks WHERE doc_id = ?').run(docId)
    this.clearDocumentGraphTx(db, docId)
  }

  /** 删除某文档的索引数据（删文件/文件夹时调用） */
  deleteDocumentIndex(docId: string): void {
    const db = this.open()
    db.transaction(() => this.clearDocumentIndexTx(db, docId))()
  }

  /** 删除整库索引数据（删库时调用） */
  deleteBaseIndex(kbId: string): void {
    const db = this.open()
    db.transaction(() => {
      const ids = db.prepare('SELECT id FROM knowledge_base_chunks WHERE kb_id = ?').all(kbId) as Array<{
        id: number
      }>
      const delFts = db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?')
      for (const row of ids) delFts.run(row.id)
      for (const table of this.listVectorTables()) {
        db.prepare(`DELETE FROM ${table} WHERE kb_id = ?`).run(kbId)
      }
      db.prepare('DELETE FROM knowledge_base_chunks WHERE kb_id = ?').run(kbId)
      db.prepare('DELETE FROM knowledge_base_entities WHERE kb_id = ?').run(kbId)
      db.prepare('DELETE FROM knowledge_base_relations WHERE kb_id = ?').run(kbId)
      db.prepare('DELETE FROM knowledge_base_communities WHERE kb_id = ?').run(kbId)
    })()
  }

  // ── 检索查询 ──

  /** 稀疏检索：调用方负责把查询串分词并转义为 MATCH 表达式 */
  searchSparse(input: {
    kbId: string
    userId: string
    match: string
    limit: number
    k1: number
    b: number
  }): Array<{ chunkId: number; score: number }> {
    const db = this.open()
    const rows = db
      .prepare(
        `SELECT rowid AS chunk_id, bm25(kb_chunk_fts, ?, ?) AS score
         FROM kb_chunk_fts
         WHERE kb_chunk_fts MATCH ? AND kb_id = ? AND user_id = ?
         ORDER BY score LIMIT ?`
      )
      .all(input.k1, input.b, input.match, input.kbId, input.userId, input.limit) as Array<{
      chunk_id: number
      score: number
    }>
    // FTS5 的 bm25() 越小越相关（负值），对外取 -score 便于展示与融合
    return rows.map((row) => ({ chunkId: row.chunk_id, score: -row.score }))
  }

  /** 关键词兜底（分词后 token 过少的短查询） */
  searchLike(input: {
    kbId: string
    userId: string
    keyword: string
    limit: number
  }): Array<{ chunkId: number; score: number }> {
    const db = this.open()
    const rows = db
      .prepare(
        `SELECT id AS chunk_id FROM knowledge_base_chunks
         WHERE kb_id = ? AND user_id = ? AND content LIKE ?
         ORDER BY id LIMIT ?`
      )
      .all(input.kbId, input.userId, `%${input.keyword}%`, input.limit) as Array<{ chunk_id: number }>
    return rows.map((row, index) => ({ chunkId: row.chunk_id, score: 1 / (index + 1) }))
  }

  /**
   * 稠密检索：sqlite-vec 可用时走 vec0 KNN（过滤下推），否则 JS 余弦兜底。
   * 距离换算：向量入库前做 L2 归一化，vec0 默认 L2 距离 → cos = 1 - d²/2。
   */
  searchDense(input: {
    kbId: string
    userId: string
    vector: Float32Array
    dim: number
    limit: number
    docIds?: string[]
  }): Array<{ chunkId: number; score: number }> {
    const db = this.open()
    if (this.getVectorBackend() === 'sqlite-vec') {
      const table = vectorTableName(input.dim)
      const exists = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { ok: number } | undefined
      if (exists) {
        const rows = db
          .prepare(
            `SELECT chunk_id, distance FROM ${table}
             WHERE embedding MATCH ? AND k = ? AND kb_id = ? AND user_id = ?
             ORDER BY distance`
          )
          .all(input.vector, input.limit, input.kbId, input.userId) as Array<{
          chunk_id: number
          distance: number
        }>
        return rows.map((row) => ({
          chunkId: row.chunk_id,
          score: 1 - (row.distance * row.distance) / 2
        }))
      }
    }
    // JS 兜底：分批扫描该库的向量 BLOB 做余弦
    const result: Array<{ chunkId: number; score: number }> = []
    const pageSize = 2000
    let offset = 0
    const stmt = db.prepare(
      `SELECT id, embedding FROM knowledge_base_chunks
       WHERE kb_id = ? AND user_id = ? AND embedding IS NOT NULL
       ORDER BY id LIMIT ? OFFSET ?`
    )
    for (;;) {
      const rows = stmt.all(input.kbId, input.userId, pageSize, offset) as Array<{
        id: number
        embedding: Buffer
      }>
      if (!rows.length) break
      for (const row of rows) {
        const vector = toFloat32(row.embedding)
        if (vector.length !== input.vector.length) continue
        let dot = 0
        for (let i = 0; i < vector.length; i += 1) dot += vector[i] * input.vector[i]
        result.push({ chunkId: row.id, score: dot })
      }
      offset += rows.length
      if (rows.length < pageSize) break
    }
    result.sort((a, b) => b.score - a.score)
    return result.slice(0, input.limit)
  }

  /** 按 chunk id 取命中内容（JOIN 文档表拿名称/相对路径；不含 storage_path） */
  getChunksByIds(ids: number[]): Array<{
    chunkId: number
    uid: string
    docId: string
    docName: string
    relPath: string
    chunkIndex: number
    heading: string | null
    content: string
    charStart: number
    charEnd: number
  }> {
    if (!ids.length) return []
    const db = this.open()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.uid, c.doc_id, c.chunk_index, c.heading, c.content, c.char_start, c.char_end,
                d.name AS doc_name, d.rel_path
         FROM knowledge_base_chunks c
         JOIN knowledge_base_documents d ON d.id = c.doc_id
         WHERE c.id IN (${placeholders})`
      )
      .all(...ids) as ChunkHitDbRow[]
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      uid: row.uid,
      docId: row.doc_id,
      docName: row.doc_name,
      relPath: row.rel_path,
      chunkIndex: row.chunk_index,
      heading: row.heading,
      content: row.content,
      charStart: row.char_start,
      charEnd: row.char_end
    }))
  }

  /** 某文档的切片（图谱抽取按块进行；按 chunk_index 排序） */
  listChunksForDoc(docId: string): Array<{ id: number; index: number; content: string }> {
    const rows = this.open()
      .prepare(
        'SELECT id, chunk_index, content FROM knowledge_base_chunks WHERE doc_id = ? ORDER BY chunk_index'
      )
      .all(docId) as Array<{ id: number; chunk_index: number; content: string }>
    return rows.map((row) => ({ id: row.id, index: row.chunk_index, content: row.content }))
  }

  countChunks(kbId: string): number {
    const row = this.open()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_chunks WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }

  /** 库内是否存在已向量化的切片（检索时判断稠密路是否可用） */
  hasVectors(kbId: string): boolean {
    const db = this.open()
    if (this.getVectorBackend() === 'sqlite-vec') {
      for (const table of this.listVectorTables()) {
        const row = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE kb_id = ? LIMIT 1`).get(kbId) as
          | { ok: number }
          | undefined
        if (row) return true
      }
      return false
    }
    const row = db
      .prepare(
        'SELECT 1 AS ok FROM knowledge_base_chunks WHERE kb_id = ? AND embedding IS NOT NULL LIMIT 1'
      )
      .get(kbId) as { ok: number } | undefined
    return Boolean(row)
  }

  // ── 文档索引状态 ──

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
    const db = this.open()
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
    this.open()
      .prepare('UPDATE knowledge_base_documents SET config = ?, updated_at = ? WHERE id = ?')
      .run(config, Date.now(), id)
  }

  /** 启动恢复：把中断残留的 queued/indexing 置为 failed（应用退出中断） */
  recoverInterruptedIndexing(): number {
    const db = this.open()
    const now = Date.now()
    return db
      .prepare(
        `UPDATE knowledge_base_documents
         SET status = 'failed', stage = NULL, error_message = ?, updated_at = ?
         WHERE status IN ('queued', 'indexing')`
      )
      .run('应用退出中断，请重新索引', now).changes
  }

  // ── 嵌入缓存（省调用；sha1(model|dim|text) → 向量）──

  getEmbeddingCache(hashes: string[]): Map<string, Float32Array> {
    const map = new Map<string, Float32Array>()
    if (!hashes.length) return map
    const db = this.open()
    // 批量查（IN 分片 500；hash 已编码 model|dim|text，无需再按 dim 过滤）
    for (let i = 0; i < hashes.length; i += 500) {
      const slice = hashes.slice(i, i + 500)
      const placeholders = slice.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT hash, vector FROM knowledge_embedding_cache WHERE hash IN (${placeholders})`
        )
        .all(...slice) as Array<{ hash: string; vector: Buffer }>
      for (const row of rows) map.set(row.hash, toFloat32(row.vector))
    }
    return map
  }

  putEmbeddingCache(entries: Array<{ hash: string; dim: number; vector: Float32Array }>): void {
    if (!entries.length) return
    const db = this.open()
    const stmt = db.prepare(
      `INSERT INTO knowledge_embedding_cache (hash, dim, vector, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET vector = excluded.vector, dim = excluded.dim`
    )
    const now = Date.now()
    db.transaction(() => {
      for (const entry of entries) {
        stmt.run(
          entry.hash,
          entry.dim,
          Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength),
          now
        )
      }
    })()
  }

  // ── 图谱（实体 / 关系）──

  /** 清某文档的图谱（重抽前先清；删文档时随索引一并清） */
  deleteDocumentGraph(docId: string): void {
    const db = this.open()
    db.transaction(() => {
      db.prepare('DELETE FROM knowledge_base_entities WHERE doc_id = ?').run(docId)
      db.prepare('DELETE FROM knowledge_base_relations WHERE doc_id = ?').run(docId)
    })()
  }

  /** 写入某文档的图谱（先清后插，单事务；实体/关系在文档内按归一键去重） */
  replaceDocumentGraph(input: {
    docId: string
    kbId: string
    userId: string
    entities: Array<{
      name: string
      nameKey: string
      type: string
      chunkId: number | null
      chunkIndex: number
      sourceText: string | null
      charStart: number | null
      charEnd: number | null
    }>
    relations: Array<{
      fromEntity: string
      toEntity: string
      fromKey: string
      toKey: string
      label: string
      chunkId: number | null
      description: string | null
    }>
  }): { entities: number; relations: number } {
    const db = this.open()
    const now = Date.now()
    const insertEntity = db.prepare(
      `INSERT INTO knowledge_base_entities
        (kb_id, doc_id, chunk_id, user_id, name, name_key, type, mentions, source_text, char_start, char_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
    const insertRelation = db.prepare(
      `INSERT INTO knowledge_base_relations
        (kb_id, doc_id, chunk_id, user_id, from_entity, to_entity, from_key, to_key, label, weight, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    const run = db.transaction((): { entities: number; relations: number } => {
      this.clearDocumentGraphTx(db, input.docId)
      let entities = 0
      for (const entity of input.entities) {
        insertEntity.run(
          input.kbId,
          input.docId,
          entity.chunkId,
          input.userId,
          entity.name,
          entity.nameKey,
          entity.type,
          entity.sourceText,
          entity.charStart,
          entity.charEnd,
          now
        )
        entities += 1
      }
      let relations = 0
      for (const relation of input.relations) {
        insertRelation.run(
          input.kbId,
          input.docId,
          relation.chunkId,
          input.userId,
          relation.fromEntity,
          relation.toEntity,
          relation.fromKey,
          relation.toKey,
          relation.label,
          relation.description,
          now
        )
        relations += 1
      }
      return { entities, relations }
    })
    return run()
  }

  private clearDocumentGraphTx(db: Database.Database, docId: string): void {
    db.prepare('DELETE FROM knowledge_base_entities WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM knowledge_base_relations WHERE doc_id = ?').run(docId)
  }

  /** 库内实体聚合视图（按 name_key + type 折叠，mentions 为出现次数） */
  listEntities(kbId: string, limit = 200): Array<{
    name: string
    nameKey: string
    type: string
    mentions: number
  }> {
    const rows = this.open()
      .prepare(
        `SELECT name, name_key, type, COUNT(*) AS mentions
         FROM knowledge_base_entities WHERE kb_id = ?
         GROUP BY name_key, type
         ORDER BY mentions DESC, name ASC
         LIMIT ?`
      )
      .all(kbId, limit) as Array<{ name: string; name_key: string; type: string; mentions: number }>
    return rows.map((row) => ({
      name: row.name,
      nameKey: row.name_key,
      type: row.type,
      mentions: row.mentions
    }))
  }

  countGraphEntities(kbId: string): number {
    const row = this.open()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }

  /** 某文档的图谱（重抽后回写文档级计数用） */
  countDocumentGraph(docId: string): { entities: number; relations: number } {
    const db = this.open()
    const entities = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE doc_id = ?')
      .get(docId) as { c: number }
    const relations = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_relations WHERE doc_id = ?')
      .get(docId) as { c: number }
    return { entities: entities.c, relations: relations.c }
  }

  /** 某文档的实体名（重抽失败提示 / 前端展示用） */
  listDocumentGraph(docId: string): Array<{ name: string; nameKey: string; type: string }> {
    const rows = this.open()
      .prepare('SELECT name, name_key, type FROM knowledge_base_entities WHERE doc_id = ?')
      .all(docId) as Array<{ name: string; name_key: string; type: string }>
    return rows.map((row) => ({ name: row.name, nameKey: row.name_key, type: row.type }))
  }

  /**
   * 图谱扩展召回（检索侧第三路）。
   *
   * 1. 用归一键在查询串里找**种子实体**：`instr(查询串归一, name_key) > 0`
   *    （SQLite 的 instr 即子串匹配；名字长度 ≥ 2 避免单字误命中）；
   * 2. 沿关系找一跳邻居（from_key/to_key 任一命中即算）；
   * 3. 把这些实体的 `chunk_id` 作为候选切片返回（跳过 NULL）。
   *
   * 返回 `{ chunkIds, seedNames }`：seedNames 供问答上下文提示「知识关联」用。
   */
  graphExpand(input: {
    kbId: string
    userId: string
    query: string
    limit: number
  }): { chunkIds: number[]; seedNames: string[] } {
    const db = this.open()
    const normalizedQuery = normalizeName(input.query)
    if (!normalizedQuery) return { chunkIds: [], seedNames: [] }

    const seeds = db
      .prepare(
        `SELECT DISTINCT name_key, name FROM knowledge_base_entities
         WHERE kb_id = ? AND user_id = ? AND length(name_key) >= 2 AND instr(?, name_key) > 0
         LIMIT 20`
      )
      .all(input.kbId, input.userId, normalizedQuery) as Array<{ name_key: string; name: string }>
    if (!seeds.length) return { chunkIds: [], seedNames: [] }
    const seedKeys = seeds.map((row) => row.name_key)

    // 一跳邻居（含种子自身）
    const neighborKeys = new Set<string>(seedKeys)
    const placeholders = seedKeys.map(() => '?').join(',')
    const relations = db
      .prepare(
        `SELECT from_key, to_key FROM knowledge_base_relations
         WHERE kb_id = ? AND user_id = ?
           AND (from_key IN (${placeholders}) OR to_key IN (${placeholders}))`
      )
      .all(input.kbId, input.userId, ...seedKeys, ...seedKeys) as Array<{
      from_key: string
      to_key: string
    }>
    for (const relation of relations) {
      neighborKeys.add(relation.from_key)
      neighborKeys.add(relation.to_key)
    }

    const keys = [...neighborKeys]
    const keyPlaceholders = keys.map(() => '?').join(',')
    const chunks = db
      .prepare(
        `SELECT DISTINCT chunk_id FROM knowledge_base_entities
         WHERE kb_id = ? AND user_id = ? AND chunk_id IS NOT NULL AND name_key IN (${keyPlaceholders})
         LIMIT ?`
      )
      .all(input.kbId, input.userId, ...keys, input.limit) as Array<{ chunk_id: number }>

    return {
      chunkIds: chunks.map((row) => row.chunk_id),
      seedNames: seeds.map((row) => row.name)
    }
  }

  // ── 社区摘要（GraphRAG 全局检索）──

  /** 载入整库实体图（跨文档按归一键折叠；供社区发现用） */
  loadKbGraph(kbId: string): {
    entityIndex: Map<string, { name: string; type: string; sourceText: string | null }>
    entities: Array<{ key: string }>
    relations: Array<{ from: string; to: string; label: string }>
  } {
    const db = this.open()
    const entityRows = db
      .prepare(
        `SELECT name_key, name, type, source_text FROM knowledge_base_entities WHERE kb_id = ?`
      )
      .all(kbId) as Array<{
      name_key: string
      name: string
      type: string
      source_text: string | null
    }>
    const entityIndex = new Map<string, { name: string; type: string; sourceText: string | null }>()
    for (const row of entityRows) {
      // 同名跨文档只留一条（名字/类型取首次出现的；source_text 取第一条非空的）
      const existing = entityIndex.get(row.name_key)
      if (existing) {
        if (!existing.sourceText && row.source_text) existing.sourceText = row.source_text
        continue
      }
      entityIndex.set(row.name_key, {
        name: row.name,
        type: row.type,
        sourceText: row.source_text
      })
    }
    const relationRows = db
      .prepare(
        `SELECT from_key, to_key, label FROM knowledge_base_relations WHERE kb_id = ?`
      )
      .all(kbId) as Array<{ from_key: string; to_key: string; label: string }>
    return {
      entityIndex,
      entities: [...entityIndex.keys()].map((key) => ({ key })),
      relations: relationRows.map((row) => ({
        from: row.from_key,
        to: row.to_key,
        label: row.label
      }))
    }
  }

  /** 替换某库的社区摘要（先清后写，单事务；空数组 = 清空） */
  replaceCommunities(input: {
    kbId: string
    userId: string
    communities: Array<{ entityKeys: string[]; summary: string }>
  }): number {
    const db = this.open()
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO knowledge_base_communities (kb_id, user_id, level, entity_keys, summary, entity_count, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?)`
    )
    const run = db.transaction((): number => {
      db.prepare('DELETE FROM knowledge_base_communities WHERE kb_id = ?').run(input.kbId)
      for (const community of input.communities) {
        insert.run(
          input.kbId,
          input.userId,
          JSON.stringify(community.entityKeys),
          community.summary,
          community.entityKeys.length,
          now
        )
      }
      return input.communities.length
    })
    return run()
  }

  /** 读某库的社区摘要（按社区规模从大到小） */
  listCommunities(kbId: string, limit = 12): Array<{ entityKeys: string[]; summary: string }> {
    const rows = this.open()
      .prepare(
        `SELECT entity_keys, summary FROM knowledge_base_communities
         WHERE kb_id = ? ORDER BY entity_count DESC, id ASC LIMIT ?`
      )
      .all(kbId, limit) as Array<{ entity_keys: string; summary: string }>
    return rows.map((row) => {
      let entityKeys: string[] = []
      try {
        const parsed = JSON.parse(row.entity_keys) as unknown
        if (Array.isArray(parsed)) entityKeys = parsed.filter((item): item is string => typeof item === 'string')
      } catch {
        entityKeys = []
      }
      return { entityKeys, summary: row.summary }
    })
  }

  countCommunities(kbId: string): number {
    const row = this.open()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_communities WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }

  /** 重算某库的索引汇总计数（切片/实体/已索引文档数/最近索引时间） */
  recountBaseIndex(kbId: string): void {
    const db = this.open()
    const chunks = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_chunks WHERE kb_id = ?')
      .get(kbId) as { c: number }
    const entities = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE kb_id = ?')
      .get(kbId) as { c: number }
    const docs = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexed_docs,
                COALESCE(MAX(indexed_at), 0) AS last_indexed
         FROM knowledge_base_documents WHERE kb_id = ?`
      )
      .get(kbId) as { indexed_docs: number; last_indexed: number }
    db.prepare(
      `UPDATE knowledge_bases SET chunks_count = ?, entities_count = ?, indexed_docs_count = ?, last_indexed_at = ? WHERE id = ?`
    ).run(chunks.c, entities.c, docs.indexed_docs, docs.last_indexed || null, kbId)
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
