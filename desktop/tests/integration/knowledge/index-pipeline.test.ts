import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChunkingService } from '../../../src/main/knowledge/ChunkingService'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeIndexService } from '../../../src/main/knowledge/KnowledgeIndexService'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { SparseIndexer } from '../../../src/main/knowledge/SparseIndexer'
import type { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'
import type { KnowledgeChunk, KnowledgeDocumentRow } from '../../../src/main/knowledge/types'

/**
 * 索引管线集成测试：真实 SQLite（index.db + FTS5 + sqlite-vec）全链路。
 *
 * 需要 better-sqlite3 的 **Node ABI**（与 tests/integration/database 相同前提）：
 *   cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js --force
 * 跑完切回 Electron：node scripts/ensure-better-sqlite3-electron.cjs
 */

const nodeRequire = createRequire(import.meta.url)
const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath: () => string }

let dir: string
let store: KnowledgeStore
let files: KnowledgeFileService
let sparse: SparseIndexer
let chunking: ChunkingService
let kbId: string

const DIM = 1024

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-index-'))
  store = new KnowledgeStore(() => dir)
  files = new KnowledgeFileService(store, {
    getDir: () => dir,
    getLimits: () => ({ maxUploadSizeMB: 10, maxFilesPerBatch: 20, uploadTimeoutMinutes: 10 })
  })
  sparse = new SparseIndexer(store)
  chunking = new ChunkingService()
  kbId = store.createBase('u1', { name: '资料库', description: '', kind: 'local' }).id
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个真实源文件 */
function srcFile(name: string, content: string): string {
  const sourceDir = join(dir, 'src')
  mkdirSync(sourceDir, { recursive: true })
  const file = join(sourceDir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

/** 造一个文档行（store 级测试用；storagePath 指向临时目录内的假文件） */
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
  return { index, content, tokenCount: content.length, charStart: index * 100, charEnd: index * 100 + content.length }
}

/** 确定性「伪嵌入」：按字符/词哈希分桶 + L2 归一化（管线测试只关心接线，不关心语义质量） */
function fakeEmbed(text: string, dim = DIM): Float32Array {
  const vector = new Float32Array(dim)
  const units = text.match(/[一-鿿]|[a-zA-Z0-9]+/g) ?? []
  for (const unit of units) {
    let hash = 0
    for (const char of unit) hash = (hash * 31 + char.codePointAt(0)!) % 100000
    vector[hash % dim] += 1
  }
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i += 1) vector[i] /= norm
  return vector
}

describe('KnowledgeStore 索引写入与检索（sqlite-vec 路径）', () => {
  beforeEach(() => {
    const result = store.loadVectorExtension(sqliteVec.getLoadablePath())
    expect(result.ok, `sqlite-vec 加载失败：${result.error}`).toBe(true)
    expect(store.ensureSparseIndex()).toBe(true)
    expect(store.ensureVectorTable(DIM)).toBe(true)
  })

  it('写入切片（含向量）后：稀疏、稠密、按 id 取内容三条路都可用', () => {
    insertDoc('doc-1')
    const chunks = [chunk(0, '向量检索 使用 余弦 相似度'), chunk(1, '图谱 抽取 实体 关系'), chunk(2, '无关 内容 天气')]
    const written = store.replaceDocumentIndex({
      docId: 'doc-1',
      kbId,
      userId: 'u1',
      chunks,
      tokens: chunks.map((item) => sparse.tokenize(item.content)),
      vectors: chunks.map((item) => fakeEmbed(item.content)),
      vectorDim: DIM,
      vectorModel: 'fake-embed'
    })
    expect(written).toBe(3)
    // JOIN 文档表拿到引用展示所需信息（不含 storage_path）
    const detail = store.getChunksByIds([1])[0]
    expect(detail.docName).toBe('doc-1.md')
    expect(detail.relPath).toBe('notes/doc-1.md')
    expect(JSON.stringify(detail)).not.toContain(dir)
  })

  it('稀疏命中：MATCH 表达式由分词结果构造，BM25 排序与 k1/b 生效', () => {
    insertDoc('doc-1')
    const chunks = [chunk(0, '向量检索 与 混合 检索'), chunk(1, '图谱 抽取'), chunk(2, '天气 预报')]
    store.replaceDocumentIndex({
      docId: 'doc-1',
      kbId,
      userId: 'u1',
      chunks,
      tokens: chunks.map((item) => sparse.tokenize(item.content)),
      vectors: null,
      vectorDim: null,
      vectorModel: null
    })
    const hits = sparse.search({ kbId, userId: 'u1', query: '向量检索', limit: 5, k1: 1.5, b: 0.75 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].chunkId).toBe(1)
  })

  it('稠密命中：vec0 KNN + kb/user 过滤下推', () => {
    insertDoc('doc-1')
    const chunks = [chunk(0, '苹果 香蕉'), chunk(1, '引擎 涡轮')]
    store.replaceDocumentIndex({
      docId: 'doc-1',
      kbId,
      userId: 'u1',
      chunks,
      tokens: chunks.map((item) => sparse.tokenize(item.content)),
      vectors: chunks.map((item) => fakeEmbed(item.content)),
      vectorDim: DIM,
      vectorModel: 'fake-embed'
    })
    const hits = store.searchDense({
      kbId,
      userId: 'u1',
      vector: fakeEmbed('引擎 涡轮'),
      dim: DIM,
      limit: 5
    })
    expect(hits.length).toBe(2)
    expect(hits[0].chunkId).toBe(2)
    // 隔离：别的用户/库查不到
    expect(store.searchDense({ kbId, userId: 'u2', vector: fakeEmbed('引擎'), dim: DIM, limit: 5 })).toEqual([])
    expect(store.hasVectors(kbId)).toBe(true)
  })

  it('重建幂等：同一文档重复写入不产生重复行（FTS/向量都随切片一起重建）', () => {
    insertDoc('doc-1')
    const first = [chunk(0, '甲 内容'), chunk(1, '乙 内容')]
    const write = (chunks: KnowledgeChunk[]): number =>
      store.replaceDocumentIndex({
        docId: 'doc-1',
        kbId,
        userId: 'u1',
        chunks,
        tokens: chunks.map((item) => sparse.tokenize(item.content)),
        vectors: chunks.map((item) => fakeEmbed(item.content)),
        vectorDim: DIM,
        vectorModel: 'fake-embed'
      })
    expect(write(first)).toBe(2)
    expect(write(first)).toBe(2)
    expect(store.countChunks(kbId)).toBe(2)
    const hits = sparse.search({ kbId, userId: 'u1', query: '甲内容', limit: 10, k1: 1.5, b: 0.75 })
    expect(new Set(hits.map((hit) => hit.chunkId)).size).toBe(hits.length)

    // 改配置重建（3 块）：旧行被清掉，向量表也不留孤儿
    const second = [chunk(0, '甲 内容'), chunk(1, '乙 内容'), chunk(2, '丙 内容')]
    expect(write(second)).toBe(3)
    expect(store.countChunks(kbId)).toBe(3)
    expect(store.searchDense({ kbId, userId: 'u1', vector: fakeEmbed('丙 内容'), dim: DIM, limit: 10 })).toHaveLength(3)
  })

  it('删除文档索引：切片/稀疏/向量一并清理', () => {
    insertDoc('doc-1')
    const chunks = [chunk(0, '待删除 内容')]
    store.replaceDocumentIndex({
      docId: 'doc-1',
      kbId,
      userId: 'u1',
      chunks,
      tokens: chunks.map((item) => sparse.tokenize(item.content)),
      vectors: chunks.map((item) => fakeEmbed(item.content)),
      vectorDim: DIM,
      vectorModel: 'fake-embed'
    })
    store.deleteDocumentIndex('doc-1')
    expect(store.countChunks(kbId)).toBe(0)
    expect(sparse.search({ kbId, userId: 'u1', query: '待删除', limit: 5, k1: 1.5, b: 0.75 })).toEqual([])
    expect(store.hasVectors(kbId)).toBe(false)
  })

  it('embedding 缓存：写入后可批量取回', () => {
    const vector = fakeEmbed('缓存 向量')
    store.putEmbeddingCache([{ hash: 'h1', dim: DIM, vector }])
    const cached = store.getEmbeddingCache(['h1', 'h2'])
    expect(cached.size).toBe(1)
    expect(Array.from(cached.get('h1') ?? []).slice(0, 3)).toEqual(Array.from(vector).slice(0, 3))
  })
})

describe('KnowledgeStore 索引写入（JS 余弦降级路径）', () => {
  it('未加载扩展时：向量落 chunks.embedding，searchDense 走 JS 余弦', () => {
    expect(store.getVectorBackend()).toBe('js')
    expect(store.ensureSparseIndex()).toBe(true)
    const chunks = [chunk(0, '苹果 香蕉'), chunk(1, '引擎 涡轮')]
    store.replaceDocumentIndex({
      docId: 'doc-1',
      kbId,
      userId: 'u1',
      chunks,
      tokens: chunks.map((item) => sparse.tokenize(item.content)),
      vectors: chunks.map((item) => fakeEmbed(item.content)),
      vectorDim: DIM,
      vectorModel: 'fake-embed'
    })
    const hits = store.searchDense({
      kbId,
      userId: 'u1',
      vector: fakeEmbed('引擎 涡轮'),
      dim: DIM,
      limit: 5
    })
    expect(hits[0].chunkId).toBe(2)
    expect(store.hasVectors(kbId)).toBe(true)
  })
})

describe('KnowledgeIndexService 全链路（导入 → 索引 → 检索）', () => {
  function createService(embedAvailable: boolean): {
    service: KnowledgeIndexService
    progress: string[]
  } {
    const engineConfig: Partial<KnowledgeEngineConfig> = {
      chunkStrategy: 'recursive',
      chunkSize: 60,
      chunkOverlap: 10,
      vectorDimensions: DIM,
      embeddingModel: 'fake-embed',
      sparseRetrieval: true,
      bm25K1: 1.5,
      bm25B: 0.75,
      graphEnabled: false
    }
    const settings = {
      getEffective: () => ({ effective: engineConfig, overridden: [] })
    } as unknown as KnowledgeSettingsService
    const progress: string[] = []
    const service = new KnowledgeIndexService({
      store,
      files,
      chunking,
      sparse,
      settings,
      getGlobalSettings: () => ({}),
      embedder: embedAvailable
        ? {
            available: (config) => Boolean(config.embeddingModel),
            embed: async (texts, config) => texts.map((text) => fakeEmbed(text, config.vectorDimensions))
          }
        : undefined,
      onProgress: (event) => progress.push(`${event.stage}:${event.status}`)
    })
    return { service, progress }
  }

  /** 等文档跑到终态（indexed/failed），返回最终行；断言交给各用例（失败原因带进断言消息） */
  async function waitForTerminal(docId: string, timeoutMs = 5000): Promise<KnowledgeDocumentRow> {
    const start = Date.now()
    for (;;) {
      const doc = store.getDocumentById(docId)
      if (doc && (doc.status === 'indexed' || doc.status === 'failed')) return doc
      if (Date.now() - start > timeoutMs) throw new Error('等待索引超时')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('导入 → 队列消费 → indexed，命中可检索且带文档信息', async () => {
    const { service, progress } = createService(true)
    const content = [
      '# 向量检索',
      '向量检索使用余弦相似度计算距离。',
      '混合检索融合向量与关键词两路结果。',
      '# 图谱',
      '图谱抽取从文档中提取实体与关系。'
    ].join('\n')
    const result = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('rag.md', content), relPath: 'notes/rag.md' }],
      'default'
    )
    const docId = result.accepted[0].id
    service.enqueue('u1', kbId, [docId])
    const doc = await waitForTerminal(docId)

    expect(doc.status, doc.errorMessage ?? '').toBe('indexed')
    expect(doc.chunksCount).toBeGreaterThan(0)
    expect(doc.indexedAt).toBeTruthy()
    expect(doc.charCount).toBeGreaterThan(0)
    expect(progress).toContain('indexed:indexed')

    const hits = sparse.search({ kbId, userId: 'u1', query: '向量检索', limit: 5, k1: 1.5, b: 0.75 })
    expect(hits.length).toBeGreaterThan(0)
    const detail = store.getChunksByIds([hits[0].chunkId])[0]
    expect(detail.docName).toBe('rag.md')
    expect(detail.relPath).toBe('notes/rag.md')
    expect(detail.content.length).toBeGreaterThan(0)

    // 库级汇总计数已回算
    expect(store.getBase('u1', kbId)?.indexedDocsCount).toBe(1)
    expect(store.getBase('u1', kbId)?.chunksCount).toBe(doc?.chunksCount)
  })

  it('无嵌入端点：纯稀疏闭环，文档仍 indexed', async () => {
    const { service } = createService(false)
    const result = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('plain.md', '纯稀疏索引内容。关键词检索可用。'), relPath: 'plain.md' }],
      'default'
    )
    const docId = result.accepted[0].id
    service.enqueue('u1', kbId, [docId])
    const doc = await waitForTerminal(docId)
    expect(doc.status, doc.errorMessage ?? '').toBe('indexed')
    expect(store.hasVectors(kbId)).toBe(false)
    expect(sparse.search({ kbId, userId: 'u1', query: '关键词', limit: 5, k1: 1.5, b: 0.75 }).length).toBeGreaterThan(0)
  })

  it('解析不出文本（二进制嗅探拒绝）→ failed 且带原因', async () => {
    const { service } = createService(false)
    const binary = srcFile('blob.md', 'NUL\u0000\u0000binary')
    const result = files.importDocuments('u1', kbId, [{ srcPath: binary, relPath: 'blob.md' }], 'default')
    const docId = result.accepted[0].id
    service.enqueue('u1', kbId, [docId])
    const doc = await waitForTerminal(docId)
    expect(doc.status).toBe('failed')
    expect(doc.errorMessage).toBeTruthy()
  })

  it('取消：运行中取消后状态回退且不写半截索引', async () => {
    const { service } = createService(true)
    const result = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('cancel.md', '取消测试内容。'.repeat(200)), relPath: 'cancel.md' }],
      'default'
    )
    const docId = result.accepted[0].id
    service.enqueue('u1', kbId, [docId])
    service.cancel([docId])
    await new Promise((resolve) => setTimeout(resolve, 80))
    const doc = store.getDocumentById(docId)
    expect(doc?.status).not.toBe('indexing')
    expect(store.countChunks(kbId)).toBe(0)
  })

  it('启动恢复：queued/indexing 残留被置为 failed', () => {
    const result = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('zombie.md', '僵尸态'), relPath: 'zombie.md' }],
      'default'
    )
    const docId = result.accepted[0].id
    store.updateDocumentIndexState(docId, { status: 'indexing', stage: 'parsing' })
    const recovered = store.recoverInterruptedIndexing()
    expect(recovered).toBeGreaterThanOrEqual(1)
    const doc = store.getDocumentById(docId)
    expect(doc?.status).toBe('failed')
    expect(doc?.errorMessage).toContain('中断')
  })
})
