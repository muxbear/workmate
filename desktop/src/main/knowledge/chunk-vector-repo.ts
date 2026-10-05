import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { KnowledgeChunk } from './types'
import { toFloat32, type VectorBackend } from './vector-backend'
import type { GraphRepo } from './graph-repo'

/**
 * 切片与向量仓储（R5：KnowledgeStore 拆 Repository 第五刀，纯搬移）。
 *
 * - SQL 与表结构（knowledge_base_chunks / kb_chunk_fts / kb_chunk_vec_* /
 *   knowledge_embedding_cache）逐字未动；写入器与两个映射型查询原样搬迁；
 * - KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）；
 * - 文档级清理（chunks/FTS/向量）需要同时清图谱：经 deps.graph 在同一事务内调用；
 * - 向量后端选择经 deps.getBackend 注入（解析仍归 store 的 kb_meta）。
 */

/** 索引写入的批次大小（每批一个事务；见 createDocumentIndexWriter 的原子性说明） */
const INDEX_WRITE_BATCH = 1500

/** 索引写入入参 */
export interface DocumentIndexWriteInput {
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
}

/** 按批推进的索引写入器（批间由 async 调用方让出事件循环） */
export interface DocumentIndexWriter {
  done: boolean
  written: number
  writeNextBatch: () => void
}

/** 切片稳定标识：sha1(docId:chunkIndex)，幂等重灌时同一位置得到同一 uid */
export function chunkUid(docId: string, chunkIndex: number): string {
  return createHash('sha1').update(`${docId}:${chunkIndex}`).digest('hex')
}

/** 依赖接缝（连接与迁移仍归 KnowledgeStore；meta/后端解析经 thunk 注入） */
export interface ChunkVectorRepoDeps {
  getDb: () => Database.Database
  getMeta: (key: string) => string | null
  getBackend: () => VectorBackend
  graph: GraphRepo
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

/** 切片 + JOIN 文档表后的命中行（docName/relPath 供引用展示；uploaded_at 供时间衰减） */
interface ChunkHitDbRow extends ChunkDbRow {
  doc_name: string
  rel_path: string
  uploaded_at: number
}

export class ChunkVectorRepo {
  constructor(private readonly deps: ChunkVectorRepoDeps) {}

  /**
   * 用一批切片替换某文档的全部索引数据（幂等重建的落点）。
   *
   * **原子性口径（2026-10-03 调整）**：旧数据的清理是独立事务（先清后写，
   * 保证不出现「新旧混存」）；新数据按 `INDEX_WRITE_BATCH` 分批、**每批一个事务**。
   * 大文档（2MB ≈ 6500 切片）单事务写入会让主进程 0.7s 不回到事件循环，分批后
   * 每批阻塞降一个数量级。批间崩溃只会留下「该文档不完整」的中间态——文档此时仍是
   * `indexing`，启动恢复会把它置为 failed，重建也会先清空再写，不会污染检索
   * （检索只返回已提交批次的数据，用户看到的计数在写完后才回写）。
   *
   * 单批内完成：插切片 → 插 FTS 行（rowid 对齐）→ 写向量。
   * - 向量后端为 sqlite-vec 时写入 `kb_chunk_vec_<dim>`（chunk_id 主键必须
   *   用 BigInt 绑定：better-sqlite3 默认把 number 绑成 REAL，vec0 会拒绝）；
   * - 降级模式写入 `knowledge_base_chunks.embedding` BLOB。
   * 返回写入的切片数。
   */
  replaceDocumentIndex(input: DocumentIndexWriteInput): number {
    const writer = this.createDocumentIndexWriter(input)
    while (!writer.done) writer.writeNextBatch()
    return writer.written
  }

  /**
   * 创建「按批推进」的索引写入器。
   *
   * 引出它的原因（性能基准实测）：2MB 单文档 ≈ 6500 切片的写入是一次同步调用，
   * 主进程会有 ~700ms 不回到事件循环。写入器把写入切成批次，**由 async 调用方
   * 在批间 `await` 让出**（store 自身保持同步 API）。
   *
   * 调用约定：`while (!writer.done) writer.writeNextBatch()` 循环，每批之后让出。
   * 便利方法 `replaceDocumentIndex` 就是「一次同步跑完」（单测/小文档用）。
   */
  createDocumentIndexWriter(input: DocumentIndexWriteInput): DocumentIndexWriter {
    const db = this.deps.getDb()
    const now = Date.now()
    const backend = this.deps.getBackend()
    const hasFts = this.deps.getMeta('fts5_ready') === '1'
    const tokens = input.tokens
    const vectors = input.vectors
    const dim = input.vectorDim

    const insertChunk = db.prepare(
      `INSERT INTO knowledge_base_chunks
        (uid, kb_id, doc_id, user_id, chunk_index, content, token_count, heading, char_start, char_end, embedding, vector_dim, vector_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // FTS 语句必须等表确认可用后再准备（FTS5 不可用的构建上预编译会直接抛错）
    const insertFts = hasFts
      ? db.prepare('INSERT INTO kb_chunk_fts(rowid, text_tokens, kb_id, user_id) VALUES (?, ?, ?, ?)')
      : null

    // 清旧（独立事务，先落地：分批写入时不会把旧数据留到中途）
    db.transaction(() => this.clearDocumentIndexTx(db, input.docId))()

    // 向量落库执行器：sqlite-vec 写向量表（按需惰性建表——首次写入该维度时建，
    // 测试里预建表会掩盖这一步，别删）；js 兜底为 null（向量随切片行 BLOB 写入）
    const vecSink = vectors
      ? backend.createBatchSink(db, {
          dim,
          kbId: input.kbId,
          userId: input.userId,
          docId: input.docId,
          vectors
        })
      : null

    let offset = 0
    let writtenCount = 0
    const writeNextBatch = (): void => {
      const end = Math.min(offset + INDEX_WRITE_BATCH, input.chunks.length)
      const runBatch = db.transaction((): number => {
        const ids: number[] = []
        for (let i = offset; i < end; i += 1) {
          const chunk = input.chunks[i]
          const vector = vectors?.[i] ?? null
          const blob = backend.embeddingCell(vector)
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
        }
        if (insertFts && tokens) {
          ids.forEach((id, i) => insertFts.run(id, tokens[offset + i] ?? '', input.kbId, input.userId))
        }
        if (vecSink) vecSink(ids, offset)
        return ids.length
      })
      writtenCount += runBatch()
      offset = end
    }

    return {
      get done(): boolean {
        return offset >= input.chunks.length
      },
      get written(): number {
        return writtenCount
      },
      writeNextBatch
    }
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
    for (const table of this.deps.getBackend().listTables(db)) {
      db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(docId)
    }
    db.prepare('DELETE FROM knowledge_base_chunks WHERE doc_id = ?').run(docId)
    this.deps.graph.clearForDocTx(db, docId)
  }

  /** 删除某文档的索引数据（删文件/文件夹时调用） */
  deleteDocumentIndex(docId: string): void {
    const db = this.deps.getDb()
    db.transaction(() => this.clearDocumentIndexTx(db, docId))()
  }

  /** 删除整库索引数据（删库时调用） */
  deleteBaseIndex(kbId: string): void {
    const db = this.deps.getDb()
    db.transaction(() => {
      const ids = db.prepare('SELECT id FROM knowledge_base_chunks WHERE kb_id = ?').all(kbId) as Array<{
        id: number
      }>
      const delFts = db.prepare('DELETE FROM kb_chunk_fts WHERE rowid = ?')
      for (const row of ids) delFts.run(row.id)
      for (const table of this.deps.getBackend().listTables(db)) {
        db.prepare(`DELETE FROM ${table} WHERE kb_id = ?`).run(kbId)
      }
      db.prepare('DELETE FROM knowledge_base_chunks WHERE kb_id = ?').run(kbId)
      this.deps.graph.clearForKbTx(db, kbId)
    })()
  }

  /** 稀疏检索：调用方负责把查询串分词并转义为 MATCH 表达式 */
  searchSparse(input: {
    kbId: string
    userId: string
    match: string
    limit: number
    k1: number
    b: number
  }): Array<{ chunkId: number; score: number }> {
    const db = this.deps.getDb()
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
    const db = this.deps.getDb()
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
    return this.deps.getBackend().search(this.deps.getDb(), input)
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
    if (!ids.length) return []
    const db = this.deps.getDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.uid, c.doc_id, c.chunk_index, c.heading, c.content, c.char_start, c.char_end,
                d.name AS doc_name, d.rel_path, d.uploaded_at
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
      charEnd: row.char_end,
      uploadedAt: row.uploaded_at
    }))
  }

  /**
   * 按 chunk id 批量取 FTS 里的分词串（MMR 的 token 相似度用；与 BM25 同一词表）。
   * FTS5 不可用时返回空 Map（调用方回退到 SparseIndexer.tokenize 现切）。
   */
  getChunkTokens(ids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (!ids.length || this.deps.getMeta('fts5_ready') !== '1') return out
    const db = this.deps.getDb()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT rowid AS chunk_id, text_tokens FROM kb_chunk_fts WHERE rowid IN (${placeholders})`)
      .all(...ids) as Array<{ chunk_id: number; text_tokens: string }>
    for (const row of rows) out.set(row.chunk_id, row.text_tokens)
    return out
  }

  /** 某文档的切片（图谱抽取按块进行；按 chunk_index 排序） */
  listChunksForDoc(docId: string): Array<{ id: number; index: number; content: string }> {
    const rows = this.deps.getDb()
      .prepare(
        'SELECT id, chunk_index, content FROM knowledge_base_chunks WHERE doc_id = ? ORDER BY chunk_index'
      )
      .all(docId) as Array<{ id: number; chunk_index: number; content: string }>
    return rows.map((row) => ({ id: row.id, index: row.chunk_index, content: row.content }))
  }

  countChunks(kbId: string): number {
    const row = this.deps.getDb()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_chunks WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }

  /** 库内是否存在已向量化的切片（检索时判断稠密路是否可用） */
  hasVectors(kbId: string): boolean {
    return this.deps.getBackend().hasVectors(this.deps.getDb(), kbId)
  }

  getEmbeddingCache(hashes: string[]): Map<string, Float32Array> {
    const map = new Map<string, Float32Array>()
    if (!hashes.length) return map
    const db = this.deps.getDb()
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
    const db = this.deps.getDb()
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
}
