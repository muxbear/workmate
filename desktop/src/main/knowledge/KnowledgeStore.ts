import { existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { resolveVectorBackend, type VectorBackend } from './vector-backend'
import { ShareRepo } from './share-repo'
import { BaseRepo } from './base-repo'
import { DocumentRepo } from './document-repo'
import { GraphRepo } from './graph-repo'
import { ChunkVectorRepo } from './chunk-vector-repo'
import type { DocumentIndexWriteInput, DocumentIndexWriter } from './chunk-vector-repo'
import { MetaStore } from './meta-store'
import type {
  KnowledgeBaseRow,
  KnowledgeDocStatus,
  KnowledgeDocumentRow,
  KnowledgeGraphView,
  KnowledgeIndexStage,
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

// 文档行 → 渲染层元信息的映射只有一个实现：KnowledgeFileService.toDocumentMeta

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
  /** 索引元信息仓储（R5 拆分第六刀；getMeta/setMeta 下方为委托门面） */
  private readonly meta = new MetaStore(() => this.open())
  /** 共享仓储（R5 拆分第一刀；下方同名方法为委托门面） */
  private readonly shares = new ShareRepo(() => this.open())
  /** 知识库仓储（R5 拆分第二刀；下方同名方法为委托门面） */
  private readonly bases = new BaseRepo(() => this.open())
  /** 文档仓储（R5 拆分第三刀；下方同名方法为委托门面） */
  private readonly documents = new DocumentRepo(() => this.open())
  /** 图谱仓储（R5 拆分第四刀；下方同名方法为委托门面） */
  private readonly graph = new GraphRepo(() => this.open())
  /** 切片与向量仓储（R5 拆分第五刀；写入器/检索查询/嵌入缓存经门面委托） */
  private readonly chunks = new ChunkVectorRepo({
    getDb: () => this.open(),
    getMeta: (key) => this.getMeta(key),
    getBackend: () => this.vectorBackend(),
    graph: this.graph
  })

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

  // ── 知识库（R5：SQL 在 BaseRepo；以下为委托门面，签名/行为不变）──

  listBases(
    userId: string,
    opts: { kind?: KnowledgeKind; keyword?: string } = {}
  ): KnowledgeBaseRow[] {
    return this.bases.listBases(userId, opts)
  }

  getBase(userId: string, id: string): KnowledgeBaseRow | null {
    return this.bases.getBase(userId, id)
  }

  findBaseByName(userId: string, name: string): KnowledgeBaseRow | null {
    return this.bases.findBaseByName(userId, name)
  }

  createBase(
    userId: string,
    input: { name: string; description: string; kind: KnowledgeKind }
  ): KnowledgeBaseRow {
    return this.bases.createBase(userId, input)
  }

  updateBase(userId: string, id: string, patch: { name?: string; description?: string }): void {
    this.bases.updateBase(userId, id, patch)
  }

  /**
   * 拖拽排序：按传入顺序把某分类下的知识库写回 sort_order（0 起，越小越靠前）。
   * 只影响传进来的 id，其余行保持原值。
   */
  reorderBases(userId: string, kind: KnowledgeKind, orderedIds: string[]): number {
    return this.bases.reorderBases(userId, kind, orderedIds)
  }

  /**
   * 置顶 / 取消置顶。
   *
   * - 置顶：sort_order 取同分类置顶组最小值之前，保证它是置顶区第一条；
   * - 取消置顶：保留当前 sort_order，于是落到未置顶区的最前面。
   */
  setBasePinned(userId: string, id: string, pinned: boolean): void {
    this.bases.setBasePinned(userId, id, pinned)
  }

  deleteBase(userId: string, id: string): number {
    return this.bases.deleteBase(userId, id)
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

  // ── 文档（R5：SQL 在 DocumentRepo；以下为委托门面，签名/行为不变）──

  listDocuments(userId: string, kbId: string): KnowledgeDocumentRow[] {
    return this.documents.listDocuments(userId, kbId)
  }

  findDocument(userId: string, kbId: string, relPath: string): KnowledgeDocumentRow | null {
    return this.documents.findDocument(userId, kbId, relPath)
  }

  /** 按文档 ID 取行（索引队列按 docId 驱动，需要拿 storage_path 与快照） */
  getDocumentById(id: string): KnowledgeDocumentRow | null {
    return this.documents.getDocumentById(id)
  }

  /** 按文件夹前缀取文档（含子层级；relPath 为空表示整库） */
  listDocumentsByPrefix(userId: string, kbId: string, prefix: string): KnowledgeDocumentRow[] {
    return this.documents.listDocumentsByPrefix(userId, kbId, prefix)
  }

  /** 同库同内容哈希命中（文件去重）；excludeId 用于自身更新场景 */
  findDocumentByHash(kbId: string, hash: string, excludeId?: string): KnowledgeDocumentRow | null {
    return this.documents.findDocumentByHash(kbId, hash, excludeId)
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
    return this.documents.insertDocument(input)
  }

  /** 更新文档的名称/相对路径（重命名；storage_path 不变，磁盘按 docId 隔离） */
  updateDocumentPath(id: string, patch: { name?: string; relPath?: string }): void {
    this.documents.updateDocumentPath(id, patch)
  }

  deleteDocuments(ids: string[]): void {
    this.documents.deleteDocuments(ids)
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

  // ── 索引元信息（kb_meta 键值；R5：SQL 在 MetaStore；以下为委托门面，签名/行为不变）──

  getMeta(key: string): string | null {
    return this.meta.getMeta(key)
  }

  setMeta(key: string, value: string): void {
    this.meta.setMeta(key, value)
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

  /** 当前向量后端实现（strategy；SQL 与数据布局见 vector-backend.ts 的模块说明） */
  private vectorBackend(): VectorBackend {
    return resolveVectorBackend(this.getVectorBackend())
  }

  /** 确保某维度的向量表存在（vec0；需先 loadVectorExtension 成功）。维度一表：kb_chunk_vec_<dim> */
  ensureVectorTable(dim: number): boolean {
    return this.vectorBackend().ensureTable(this.open(), dim)
  }

  // ── 索引写入（R5：SQL 在 ChunkVectorRepo；以下为委托门面，签名/行为不变）──

  /**
   * 用一批切片替换某文档的全部索引数据（幂等重建的落点）。
   *
   * **原子性口径（2026-10-03 调整）**：旧数据的清理是独立事务（先清后写，
   * 保证不出现「新旧混存」）；新数据按 `INDEX_WRITE_BATCH` 分批、**每批一个事务**。
   * 大文档（2MB ≈ 6500 切片）单事务写入会让主进程 0.7s 不回到事件循环，分批后
   * 每批阻塞降一个数量级。批间崩溃只会留下「该文档不完整」的中间态——文档此时仍是
   * `indexing`，启动恢复会把它置为 failed，重建也会先清空再写，不会污染检索
   * （检索只返回已提交批次的数据，用户看到的计数在写完后才回写）。
   */
  replaceDocumentIndex(input: DocumentIndexWriteInput): number {
    return this.chunks.replaceDocumentIndex(input)
  }

  /**
   * 创建「按批推进」的索引写入器。
   *
   * 调用约定：`while (!writer.done) writer.writeNextBatch()` 循环，每批之后让出。
   * 便利方法 `replaceDocumentIndex` 就是「一次同步跑完」（单测/小文档用）。
   */
  createDocumentIndexWriter(input: DocumentIndexWriteInput): DocumentIndexWriter {
    return this.chunks.createDocumentIndexWriter(input)
  }

  /** 删除某文档的索引数据（删文件/文件夹时调用） */
  deleteDocumentIndex(docId: string): void {
    this.chunks.deleteDocumentIndex(docId)
  }

  /** 删除整库索引数据（删库时调用） */
  deleteBaseIndex(kbId: string): void {
    this.chunks.deleteBaseIndex(kbId)
  }

  // ── 检索查询（R5：SQL 在 ChunkVectorRepo；以下为委托门面，签名/行为不变）──

  /** 稀疏检索：调用方负责把查询串分词并转义为 MATCH 表达式 */
  searchSparse(input: {
    kbId: string
    userId: string
    match: string
    limit: number
    k1: number
    b: number
  }): Array<{ chunkId: number; score: number }> {
    return this.chunks.searchSparse(input)
  }

  /** 关键词兜底（分词后 token 过少的短查询） */
  searchLike(input: {
    kbId: string
    userId: string
    keyword: string
    limit: number
  }): Array<{ chunkId: number; score: number }> {
    return this.chunks.searchLike(input)
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
    return this.chunks.searchDense(input)
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
    /** 文档导入时间（时间衰减的事实源；见 time-decay.ts 的局限说明） */
    uploadedAt: number
  }> {
    return this.chunks.getChunksByIds(ids)
  }

  /**
   * 按 chunk id 批量取 FTS 里的分词串（MMR 的 token 相似度用；与 BM25 同一词表）。
   * FTS5 不可用时返回空 Map（调用方回退到 SparseIndexer.tokenize 现切）。
   */
  getChunkTokens(ids: number[]): Map<number, string> {
    return this.chunks.getChunkTokens(ids)
  }

  /** 某文档的切片（图谱抽取按块进行；按 chunk_index 排序） */
  listChunksForDoc(docId: string): Array<{ id: number; index: number; content: string }> {
    return this.chunks.listChunksForDoc(docId)
  }

  countChunks(kbId: string): number {
    return this.chunks.countChunks(kbId)
  }

  /** 库内是否存在已向量化的切片（检索时判断稠密路是否可用） */
  hasVectors(kbId: string): boolean {
    return this.chunks.hasVectors(kbId)
  }

  // ── 文档索引状态（R5：SQL 在 DocumentRepo；以下为委托门面，签名/行为不变）──

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
    this.documents.updateDocumentIndexState(id, patch)
  }

  /** 更新文档的索引配置快照（重建时以当前生效配置刷新，保证「改设置再重建」生效） */
  updateDocumentConfig(id: string, config: string): void {
    this.documents.updateDocumentConfig(id, config)
  }

  /** 启动恢复：把中断残留的 queued/indexing 置为 failed（应用退出中断） */
  recoverInterruptedIndexing(): number {
    return this.documents.recoverInterruptedIndexing()
  }

  // ── 嵌入缓存（R5：SQL 在 ChunkVectorRepo；以下为委托门面，签名/行为不变）──

  getEmbeddingCache(hashes: string[]): Map<string, Float32Array> {
    return this.chunks.getEmbeddingCache(hashes)
  }

  putEmbeddingCache(entries: Array<{ hash: string; dim: number; vector: Float32Array }>): void {
    this.chunks.putEmbeddingCache(entries)
  }

  // ── 图谱（实体 / 关系；R5：SQL 在 GraphRepo；以下为委托门面，签名/行为不变）──

  /** 清某文档的图谱（重抽前先清；删文档时随索引一并清） */
  deleteDocumentGraph(docId: string): void {
    this.graph.deleteDocumentGraph(docId)
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
    return this.graph.replaceDocumentGraph(input)
  }

  /** 库内实体聚合视图（按 name_key + type 折叠，mentions 为出现次数） */
  listEntities(kbId: string, limit = 200): Array<{
    name: string
    nameKey: string
    type: string
    mentions: number
  }> {
    return this.graph.listEntities(kbId, limit)
  }

  /**
   * 图谱可视化数据（只读）：节点按 name_key 折叠（代表名/类型取出现最多的一行——
   * SQLite 的 min/max 聚合裸列规则），边按 (from,to,label) 分组后由调用侧折平行边。
   * 悬挂边（端点不在节点集内）与自环在 SQL 后过滤；节点超限则整体截断（truncated）。
   */
  loadKbGraphView(kbId: string, limit = 150): KnowledgeGraphView {
    return this.graph.loadKbGraphView(kbId, limit)
  }

  countGraphEntities(kbId: string): number {
    return this.graph.countGraphEntities(kbId)
  }

  /** 某文档的图谱（重抽后回写文档级计数用） */
  countDocumentGraph(docId: string): { entities: number; relations: number } {
    return this.graph.countDocumentGraph(docId)
  }

  /** 某文档的实体名（重抽失败提示 / 前端展示用） */
  listDocumentGraph(docId: string): Array<{ name: string; nameKey: string; type: string }> {
    return this.graph.listDocumentGraph(docId)
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
    return this.graph.graphExpand(input)
  }

  // ── 社区摘要（GraphRAG 全局检索；R5：SQL 在 GraphRepo）──

  /** 载入整库实体图（跨文档按归一键折叠；供社区发现用） */
  loadKbGraph(kbId: string): {
    entityIndex: Map<string, { name: string; type: string; sourceText: string | null }>
    entities: Array<{ key: string }>
    relations: Array<{ from: string; to: string; label: string }>
  } {
    return this.graph.loadKbGraph(kbId)
  }

  /** 替换某库的社区摘要（先清后写，单事务；空数组 = 清空） */
  replaceCommunities(input: {
    kbId: string
    userId: string
    communities: Array<{ entityKeys: string[]; summary: string }>
  }): number {
    return this.graph.replaceCommunities(input)
  }

  /** 读某库的社区摘要（按社区规模从大到小） */
  listCommunities(kbId: string, limit = 12): Array<{ entityKeys: string[]; summary: string }> {
    return this.graph.listCommunities(kbId, limit)
  }

  countCommunities(kbId: string): number {
    return this.graph.countCommunities(kbId)
  }

  // ── 备份 ──

  /**
   * 备份整个索引库到指定文件（`VACUUM INTO`：一致性快照 + 顺带整理碎片）。
   *
   * - 目标文件必须不存在（SQLite 要求；由调用方选路径并确认覆盖）；
   * - 备份的是**整台机器的 index.db**（含所有库与用户的数据），不是单库导出——
   *   单库导出需要过滤复制，收益低、易与主库结构漂移，不做。
   */
  backupTo(destPath: string): { sizeBytes: number } {
    if (existsSync(destPath)) throw new Error('目标文件已存在，请换一个文件名或先删除')
    const db = this.open()
    db.prepare('VACUUM INTO ?').run(destPath)
    const { size } = statSync(destPath)
    return { sizeBytes: size }
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

  // ── 共享（R5：SQL 在 ShareRepo；以下为委托门面，签名/行为不变）──

  insertShare(input: {
    userId: string
    targetKind: KnowledgeShareRow['targetKind']
    targetId: string
    targetName: string
    permission: string
    expiresAt: number | null
  }): KnowledgeShareRow {
    return this.shares.insertShare(input)
  }

  listShares(userId: string): KnowledgeShareRow[] {
    return this.shares.listShares(userId)
  }

  /** 撤销共享：返回受影响行数（0 = 不存在或非本人） */
  revokeShare(userId: string, token: string): number {
    return this.shares.revokeShare(userId, token)
  }

  /** 删除某知识库下的全部共享记录（删库时清理） */
  deleteSharesForTarget(userId: string, targetId: string): void {
    this.shares.deleteSharesForTarget(userId, targetId)
  }
}
