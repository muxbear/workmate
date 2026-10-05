import type Database from 'better-sqlite3'

/**
 * 向量后端策略（R5「后端接口化」）：sqlite-vec（vec0 KNN）与 JS 余弦兜底两种实现，
 * 静态选择、从 KnowledgeStore 内的 5+ 处 `getVectorBackend() === 'sqlite-vec'` 分支收编而来。
 *
 * 红线：两种后端的 SQL 与数据布局**逐字未动** —— vec0 写 `kb_chunk_vec_<dim>`、
 * js 写 `knowledge_base_chunks.embedding` BLOB；「探测失败自动降级 js」语义不变
 * （loadVectorExtension 失败 → kb_meta.vector_backend='js' → 本模块解析为 js 实现）。
 * 降级路径行为由 tests/integration/knowledge/vector-fallback.test.ts 钉住。
 */

/** 某维度的向量表名（维度一表：不同库的 vectorDimensions 可以不同） */
export function vectorTableName(dim: number): string {
  return `kb_chunk_vec_${dim}`
}

/** BLOB → Float32Array 视图（零拷贝） */
export function toFloat32(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

/** 库内已建立的向量表（按维度；用于重建/删除时精确清理） */
export function listVectorTables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kb_chunk_vec_%'")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name).filter((name) => /^kb_chunk_vec_\d+$/.test(name))
}

/** 写入器每批向量的落库执行器（vec0：写向量表；js 为 null——向量随切片行 BLOB 写入） */
export type BatchVectorSink = (ids: number[], offset: number) => void

export interface VectorBackend {
  readonly kind: 'sqlite-vec' | 'js'
  /** 建某维度的向量表（幂等）；js 后端恒 false（无需表） */
  ensureTable(db: Database.Database, dim: number): boolean
  /** 库内已建向量表清单；js 后端恒空（不读向量表） */
  listTables(db: Database.Database): string[]
  /** 切片行 embedding 列取值：js 写 BLOB；vec0 写 null（向量走向量表） */
  embeddingCell(vector: Float32Array | null | undefined): Buffer | null
  /**
   * 为一次文档写入准备「每批写向量」执行器；js 后端返回 null。
   * 与旧实现逐字一致：dim 为真值时惰性建表（返回值忽略——表缺失时下面的
   * prepare 会抛错，保持原语义）；缺向量的行跳过。
   */
  createBatchSink(
    db: Database.Database,
    input: { dim: number | null; kbId: string; userId: string; docId: string; vectors: Float32Array[] }
  ): BatchVectorSink | null
  /** 稠密检索：vec0 KNN（过滤下推；表缺失时回落 JS 余弦），js 恒为 JS 余弦兜底 */
  search(
    db: Database.Database,
    input: { kbId: string; userId: string; vector: Float32Array; dim: number; limit: number }
  ): Array<{ chunkId: number; score: number }>
  /** 库内是否存在已向量化的切片（按各自后端的存储位置判断） */
  hasVectors(db: Database.Database, kbId: string): boolean
}

/** JS 余弦兜底：分批扫描该库的向量 BLOB 做点积（降序、截断；维度不符的行跳过） */
function cosineSearch(
  db: Database.Database,
  input: { kbId: string; userId: string; vector: Float32Array; limit: number }
): Array<{ chunkId: number; score: number }> {
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

/** vec0 建表（幂等）；维度非法或建表失败（如扩展未真正加载）返回 false */
function ensureVecTable(db: Database.Database, dim: number): boolean {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 8192) return false
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

/** sqlite-vec 后端（vec0 KNN + 向量表写入） */
const SQLITE_VEC_BACKEND: VectorBackend = {
  kind: 'sqlite-vec',
  ensureTable: ensureVecTable,
  listTables: listVectorTables,
  embeddingCell: () => null,
  createBatchSink(db, input) {
    if (!input.dim) return null
    // 惰性建表（返回值忽略；表缺失时下面的 prepare 会抛错——与旧实现同语义）
    ensureVecTable(db, input.dim)
    const table = vectorTableName(input.dim)
    const insertVec = db.prepare(
      `INSERT INTO ${table}(chunk_id, embedding, kb_id, user_id, doc_id) VALUES (?, ?, ?, ?, ?)`
    )
    return (ids, offset) => {
      ids.forEach((id, i) => {
        const vector = input.vectors[offset + i]
        if (!vector) return
        insertVec.run(BigInt(id), vector, input.kbId, input.userId, input.docId)
      })
    }
  },
  search(db, input) {
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
    // 向量表尚未建立：回落 JS 余弦（保留旧 searchDense 的兜底行为）
    return cosineSearch(db, input)
  },
  hasVectors(db, kbId) {
    for (const table of listVectorTables(db)) {
      const row = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE kb_id = ? LIMIT 1`).get(kbId) as
        | { ok: number }
        | undefined
      if (row) return true
    }
    return false
  }
}

/** JS 余弦后端（无扩展环境兜底；向量存 BLOB 列） */
const JS_VECTOR_BACKEND: VectorBackend = {
  kind: 'js',
  ensureTable: () => false,
  listTables: () => [],
  embeddingCell: (vector) =>
    vector ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null,
  createBatchSink: () => null,
  search: cosineSearch,
  hasVectors(db, kbId) {
    const row = db
      .prepare(
        'SELECT 1 AS ok FROM knowledge_base_chunks WHERE kb_id = ? AND embedding IS NOT NULL LIMIT 1'
      )
      .get(kbId) as { ok: number } | undefined
    return Boolean(row)
  }
}

/** 工厂：按 kb_meta.vector_backend 解析实现（未加载/加载失败 = js 兜底） */
export function resolveVectorBackend(kind: 'sqlite-vec' | 'js'): VectorBackend {
  return kind === 'sqlite-vec' ? SQLITE_VEC_BACKEND : JS_VECTOR_BACKEND
}
