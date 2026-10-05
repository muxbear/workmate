import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import type { KnowledgeChunk } from '../../../src/main/knowledge/types'

/**
 * 向量后端降级路径（js 余弦兜底）回归钉子（P5 后端接口化的等价性前提）。
 *
 * 此前只有 sqlite-vec 路径被集成测试覆盖；本文件显式钉住：
 * - 未加载扩展 / 加载失败：不抛错、kb_meta 落 'js'、getVectorBackend() 报 'js'；
 * - 写入：向量落 knowledge_base_chunks.embedding BLOB（js 模式不建/不写向量表）；
 * - hasVectors 按 BLOB 列判断；searchDense 走 JS 余弦（点积降序、维度不符跳过、user 过滤）。
 */

const DIM = 8

let dir: string
let store: KnowledgeStore
let kbId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-vecfb-'))
  store = new KnowledgeStore(() => dir)
  kbId = store.createBase('u1', { name: '降级库', description: '', kind: 'local' }).id
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function insertDoc(id: string): void {
  store.insertDocument({
    id,
    kbId,
    userId: 'u1',
    name: `${id}.md`,
    type: 'MD',
    sizeBytes: 10,
    relPath: `notes/${id}.md`,
    storagePath: join(dir, 'files', kbId, id, `${id}.md`),
    indexState: 'default',
    contentHash: null
  })
}

function chunk(index: number, content: string): KnowledgeChunk {
  return {
    index,
    content,
    tokenCount: content.length,
    charStart: index * 100,
    charEnd: index * 100 + content.length
  }
}

/** 确定性向量：直接给定桶位（JS 路径是点积，无需归一化） */
function vec(entries: Record<number, number>, dim = DIM): Float32Array {
  const out = new Float32Array(dim)
  for (const [i, v] of Object.entries(entries)) out[Number(i)] = v
  return out
}

function writeDoc(id: string, vectors: Float32Array[] | null, dim: number | null): number {
  insertDoc(id)
  return store.replaceDocumentIndex({
    docId: id,
    kbId,
    userId: 'u1',
    chunks: (vectors ?? [vec({ 0: 1 })]).map((_, i) => chunk(i, `切片 ${i}`)),
    tokens: null,
    vectors,
    vectorDim: dim,
    vectorModel: dim ? 'manual' : null
  })
}

describe('向量后端 js 兜底路径（未加载 sqlite-vec）', () => {
  it('未加载扩展：后端为 js；写入落 BLOB、hasVectors/余弦搜索可用（点积降序）', () => {
    expect(store.getVectorBackend()).toBe('js')
    const written = writeDoc('doc-1', [vec({ 0: 1, 1: 2 }), vec({ 1: 5 })], DIM)
    expect(written).toBe(2)

    expect(store.hasVectors(kbId)).toBe(true)
    const hits = store.searchDense({ kbId, userId: 'u1', vector: vec({ 1: 1 }), dim: DIM, limit: 5 })
    expect(hits.map((hit) => hit.chunkId)).toEqual([2, 1])
    expect(hits[0].score).toBeCloseTo(5)
    expect(hits[1].score).toBeCloseTo(2)
  })

  it('加载失败：不抛错、返回原因、meta 落 js，后续写入仍走 BLOB', () => {
    const result = store.loadVectorExtension(join(dir, '不存在的扩展.vec0'))
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(store.getVectorBackend()).toBe('js')

    writeDoc('doc-1', [vec({ 0: 3 })], DIM)
    expect(store.hasVectors(kbId)).toBe(true)
    const hits = store.searchDense({ kbId, userId: 'u1', vector: vec({ 0: 1 }), dim: DIM, limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0].score).toBeCloseTo(3)
  })

  it('无向量文档：hasVectors=false 且搜索为空；维度不符的 BLOB 行被跳过', () => {
    writeDoc('doc-1', null, null)
    expect(store.hasVectors(kbId)).toBe(false)
    expect(store.searchDense({ kbId, userId: 'u1', vector: vec({ 0: 1 }), dim: DIM, limit: 5 })).toEqual(
      []
    )

    // 另一条不同维度的向量（dim=4）：同 dim 请求必须跳过维度不符的行（JS 路径按长度过滤）
    insertDoc('doc-2')
    store.replaceDocumentIndex({
      docId: 'doc-2',
      kbId,
      userId: 'u1',
      chunks: [chunk(0, '切片 0')],
      tokens: null,
      vectors: [vec({ 0: 1 }, 4)],
      vectorDim: 4,
      vectorModel: 'manual'
    })
    expect(store.hasVectors(kbId)).toBe(true)
    expect(store.searchDense({ kbId, userId: 'u1', vector: vec({ 0: 1 }), dim: DIM, limit: 5 })).toEqual(
      []
    )
  })

  it('用户隔离：js 余弦路径同样按 user 过滤', () => {
    writeDoc('doc-1', [vec({ 0: 1 })], DIM)
    expect(store.searchDense({ kbId, userId: 'u2', vector: vec({ 0: 1 }), dim: DIM, limit: 5 })).toEqual(
      []
    )
    expect(store.searchDense({ kbId, userId: 'u1', vector: vec({ 0: 1 }), dim: DIM, limit: 5 })).toHaveLength(1)
  })
})
