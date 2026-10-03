import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChunkingService } from '../../../src/main/knowledge/ChunkingService'
import { EmbeddingProvider, type EmbeddingTransport } from '../../../src/main/knowledge/EmbeddingProvider'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeIndexService } from '../../../src/main/knowledge/KnowledgeIndexService'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { RetrievalService } from '../../../src/main/knowledge/RetrievalService'
import { SparseIndexer } from '../../../src/main/knowledge/SparseIndexer'
import type { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import type { KnowledgeDocumentRow } from '../../../src/main/knowledge/types'

/**
 * P1：向量化与混合检索（真实 EmbeddingProvider + 内存传输替身 + 真实 SQLite/vec0）。
 *
 * 替身把「动力/装置/增压」映射到「引擎/涡轮」，于是查询「动力装置」与文档
 * 「引擎 涡轮」字面不相交、语义相近 —— 用这一点区分稀疏路与稠密路：
 * bm25 模式应当为空，vector/hybrid 模式应当命中。
 *
 * 前提：better-sqlite3 需切换到 Node ABI（见同目录 index-pipeline.test.ts 顶部说明）。
 */

const nodeRequire = createRequire(import.meta.url)
const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath: () => string }

const DIM = 1024
const SYNONYMS: Record<string, string> = { 动力: '引擎', 装置: '涡轮', 增压: '涡轮' }

let dir: string
let store: KnowledgeStore
let files: KnowledgeFileService
let sparse: SparseIndexer
let chunking: ChunkingService
let kbId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-hybrid-'))
  store = new KnowledgeStore(() => dir)
  files = new KnowledgeFileService(store, {
    getDir: () => dir,
    getLimits: () => ({ maxUploadSizeMB: 10, maxFilesPerBatch: 20, uploadTimeoutMinutes: 10 })
  })
  sparse = new SparseIndexer(store)
  chunking = new ChunkingService()
  kbId = store.createBase('u1', { name: '引擎资料', description: '', kind: 'local' }).id
  store.loadVectorExtension(sqliteVec.getLoadablePath())
  store.ensureSparseIndex()
  store.ensureVectorTable(DIM)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function srcFile(name: string, content: string): string {
  const sourceDir = join(dir, 'src')
  mkdirSync(sourceDir, { recursive: true })
  const file = join(sourceDir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

/** 语义替身：先做同义词归一，再按字/词哈希分桶 + 归一化 */
function stubVector(text: string, dim: number): Float32Array {
  const normalized = text.replace(/动力|装置|增压/g, (m) => SYNONYMS[m] ?? m)
  const vector = new Float32Array(dim)
  for (const unit of normalized.match(/[一-鿿]|[a-z0-9]+/gi) ?? []) {
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

function makeTransport(failures = 0): {
  transport: EmbeddingTransport
  calls: Array<{ body: { input?: string[] } }>
} {
  let remaining = failures
  const calls: Array<{ body: { input?: string[] } }> = []
  return {
    calls,
    transport: async (input) => {
      calls.push({ body: { ...(input.body as { input?: string[] }) } })
      if (remaining > 0) {
        remaining -= 1
        const error = new Error('HTTP 503') as Error & { response: { status: number } }
        error.response = { status: 503 }
        throw error
      }
      const texts = (input.body as { input: string[] }).input
      return {
        data: texts.map((text, index) => ({ embedding: Array.from(stubVector(text, DIM)), index }))
      }
    }
  }
}

const EFFECTIVE = {
  chunkStrategy: 'recursive',
  chunkSize: 80,
  chunkOverlap: 10,
  embeddingModel: 'stub-embed',
  vectorDimensions: DIM,
  sparseRetrieval: true,
  bm25K1: 1.5,
  bm25B: 0.75,
  hybridWeight: 0.65,
  minSimilarity: 0,
  graphEnabled: false
}

const GLOBAL = {
  'knowledge.embeddingBaseUrl': 'http://gw.internal/v1',
  'knowledge.embeddingApiKey': 'sk-stub'
}

function settingsStub(overrides: Record<string, unknown> = {}): KnowledgeSettingsService {
  return {
    getEffective: () => ({ effective: { ...EFFECTIVE, ...overrides }, overridden: [] })
  } as unknown as KnowledgeSettingsService
}

function makeIndexService(embedder: EmbeddingProvider): KnowledgeIndexService {
  return new KnowledgeIndexService({
    store,
    files,
    chunking,
    sparse,
    settings: settingsStub(),
    getGlobalSettings: () => GLOBAL,
    embedder
  })
}

function makeRetrieval(embedder: EmbeddingProvider, overrides: Record<string, unknown> = {}): RetrievalService {
  return new RetrievalService({
    store,
    sparse,
    settings: settingsStub(overrides),
    getGlobalSettings: () => GLOBAL,
    embedder
  })
}

async function waitTerminal(docId: string): Promise<KnowledgeDocumentRow> {
  const start = Date.now()
  for (;;) {
    const doc = store.getDocumentById(docId)
    if (doc && (doc.status === 'indexed' || doc.status === 'failed')) return doc
    if (Date.now() - start > 8000) throw new Error('等待索引超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('P1 向量化与混合检索', () => {
  it('配端点后向量入库（vec0）；稀疏为空而稠密能命中的语义查询，混合模式两路齐活', async () => {
    const { transport } = makeTransport()
    const embedder = new EmbeddingProvider({ store, transport })
    const service = makeIndexService(embedder)
    const retrieval = makeRetrieval(embedder)

    const content = ['# 引擎说明', '引擎 涡轮 的 增压 系统 由 控制器 调节。', '# 天气', '今天 多云 转晴。'].join('\n')
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('engine.md', content), relPath: 'engine.md' }],
      'default'
    )
    const docId = imported.accepted[0].id
    service.enqueue('u1', kbId, [docId])
    const doc = await waitTerminal(docId)
    expect(doc.status, doc.errorMessage ?? '').toBe('indexed')
    expect(store.hasVectors(kbId)).toBe(true)

    // 关键词查询：稀疏路命中
    const keyword = await retrieval.retrieve({ userId: 'u1', kbId, query: '涡轮', mode: 'bm25' })
    expect(keyword.hits.length).toBeGreaterThan(0)
    expect(keyword.sparseSkipped).toBe(false)

    // 语义查询（字面不相交）：稀疏路为空
    const semanticSparse = await retrieval.retrieve({
      userId: 'u1',
      kbId,
      query: '动力装置',
      mode: 'bm25'
    })
    expect(semanticSparse.hits).toEqual([])

    // 同一查询走稠密路：命中且带向量分
    const semanticDense = await retrieval.retrieve({
      userId: 'u1',
      kbId,
      query: '动力装置',
      mode: 'vector'
    })
    expect(semanticDense.hits.length).toBeGreaterThan(0)
    expect(semanticDense.hits[0].vecScore).toBeGreaterThan(0)
    expect(semanticDense.vectorSkipped).toBe(false)
    expect(semanticDense.hits[0].docName).toBe('engine.md')

    // 混合模式：两路融合后仍命中；重排未接（P2）如实标记
    const hybrid = await retrieval.retrieve({ userId: 'u1', kbId, query: '动力装置' })
    expect(hybrid.hits.length).toBeGreaterThan(0)
    expect(hybrid.vectorSkipped).toBe(false)
    expect(hybrid.noRelevantResult).toBe(false)
  })

  it('相似度门限：把 minSimilarity 提到 0.99 后语义弱命中被挡下（noRelevantResult）', async () => {
    const { transport } = makeTransport()
    const embedder = new EmbeddingProvider({ store, transport })
    const service = makeIndexService(embedder)
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('engine.md', '引擎 涡轮 增压 系统'), relPath: 'engine.md' }],
      'default'
    )
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    await waitTerminal(imported.accepted[0].id)

    const strict = makeRetrieval(embedder, { minSimilarity: 0.99 })
    const result = await strict.retrieve({ userId: 'u1', kbId, query: '动力装置天气', mode: 'vector' })
    expect(result.hits).toEqual([])
    expect(result.noRelevantResult).toBe(true)
  })

  it('向量化抖动：503 重试后仍能建成索引（调用两次）', async () => {
    const { transport, calls } = makeTransport(1)
    const embedder = new EmbeddingProvider({ store, transport })
    const service = makeIndexService(embedder)
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('retry.md', '重试 向量化 测试 内容'), relPath: 'retry.md' }],
      'default'
    )
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    const doc = await waitTerminal(imported.accepted[0].id)
    expect(doc.status, doc.errorMessage ?? '').toBe('indexed')
    expect(calls.length).toBe(2)
  }, 15_000)

  it('维度不符：文档 failed 且原因可见，库内不落任何向量', async () => {
    const transport: EmbeddingTransport = async ({ body }) => {
      const texts = (body as { input: string[] }).input
      return { data: texts.map((_, index) => ({ embedding: new Array(8).fill(1), index })) }
    }
    const embedder = new EmbeddingProvider({ store, transport })
    const service = makeIndexService(embedder)
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('bad.md', '维度 不符 的 文档'), relPath: 'bad.md' }],
      'default'
    )
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    const doc = await waitTerminal(imported.accepted[0].id)
    expect(doc.status).toBe('failed')
    expect(doc.errorMessage).toContain('维度不符')
    expect(store.hasVectors(kbId)).toBe(false)
  })

  it('未配置端点：文档仍 indexed（纯稀疏），检索降级标记 vectorSkipped', async () => {
    const embedder = new EmbeddingProvider({
      store,
      // 未被调用：端点未配置时 available() 为 false，索引服务整个跳过向量化
      transport: async () => {
        throw new Error('不应被调用')
      }
    })
    const service = new KnowledgeIndexService({
      store,
      files,
      chunking,
      sparse,
      settings: settingsStub(),
      // 端点留空 → available() = false
      getGlobalSettings: () => ({}),
      embedder
    })
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('sparse.md', '纯 稀疏 链路 内容'), relPath: 'sparse.md' }],
      'default'
    )
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    const doc = await waitTerminal(imported.accepted[0].id)
    expect(doc.status, doc.errorMessage ?? '').toBe('indexed')
    expect(store.hasVectors(kbId)).toBe(false)

    const retrieval = new RetrievalService({
      store,
      sparse,
      settings: settingsStub(),
      getGlobalSettings: () => ({}),
      embedder
    })
    const result = await retrieval.retrieve({ userId: 'u1', kbId, query: '稀疏', mode: 'bm25' })
    expect(result.hits.length).toBeGreaterThan(0)
    const hybrid = await retrieval.retrieve({ userId: 'u1', kbId, query: '稀疏' })
    expect(hybrid.vectorSkipped).toBe(true)
    expect(hybrid.hits.length).toBeGreaterThan(0)
  })
})
