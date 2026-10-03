import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('P4 查询改写（Hybrid RAG 的 query enhancement）', () => {
  /** 打开稠密门限：原查询与文档零重叠时稠密路被门限挡掉，「空」才是真结论 */
  const GATED = { minSimilarity: 0.3 }

  /** 原查询与文档零字面重叠、零语义重叠；改写变体才命中 */
  function makeRewriter(variants: string[]): {
    available: (config: { queryRewriteEnabled: boolean }) => boolean
    rewrite: () => Promise<string[]>
  } {
    return {
      available: (config) => config.queryRewriteEnabled,
      rewrite: async () => variants
    }
  }

  async function seedDoc(): Promise<void> {
    const content = '# 冷启动优化\n冷启动 预热 机制 可以 显著 降低 首次 打开 的 等待 时间。'
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile('cold-start.md', content), relPath: 'cold-start.md' }],
      'default'
    )
    const service = makeIndexService(new EmbeddingProvider({ store, transport: makeTransport().transport }))
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    await waitTerminal(imported.accepted[0].id)
  }

  it('开关关闭：原查询无命中；开启且改写给出变体：变体召回命中该文档', async () => {
    await seedDoc()
    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })

    // 关闭（或没有改写器）：原查询「开机加速怎么做」与文档零重叠 → 空
    const off = new RetrievalService({
      store,
      sparse,
      settings: settingsStub({ ...GATED, queryRewriteEnabled: false }),
      getGlobalSettings: () => GLOBAL,
      embedder
    })
    const before = await off.retrieve({ userId: 'u1', kbId, query: '开机加速怎么做' })
    expect(before.hits).toEqual([])

    // 开启并注入改写器：变体命中
    const on = new RetrievalService({
      store,
      sparse,
      settings: settingsStub({ ...GATED, queryRewriteEnabled: true }),
      getGlobalSettings: () => GLOBAL,
      embedder,
      queryRewriter: makeRewriter(['冷启动 预热'])
    })
    const after = await on.retrieve({ userId: 'u1', kbId, query: '开机加速怎么做' })
    expect(after.hits.length).toBeGreaterThan(0)
    expect(after.hits[0].docName).toBe('cold-start.md')
  })

  it('改写返回空（模型失败降级）：行为与关闭时一致', async () => {
    await seedDoc()
    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })
    const service = new RetrievalService({
      store,
      sparse,
      settings: settingsStub({ ...GATED, queryRewriteEnabled: true }),
      getGlobalSettings: () => GLOBAL,
      embedder,
      queryRewriter: makeRewriter([])
    })
    const result = await service.retrieve({ userId: 'u1', kbId, query: '开机加速怎么做' })
    expect(result.hits).toEqual([])
  })
})

describe('P7 增强层（MMR / 时间衰减 / 调试载荷 / 多轮改写）', () => {
  /** 打开稠密门限：零重叠查询的稠密噪声被挡掉，「空」才是真结论 */
  const GATED = { minSimilarity: 0.3 }

  async function seedDoc(name: string, content: string): Promise<void> {
    const imported = files.importDocuments(
      'u1',
      kbId,
      [{ srcPath: srcFile(name, content), relPath: name }],
      'default'
    )
    const service = makeIndexService(
      new EmbeddingProvider({ store, transport: makeTransport().transport })
    )
    service.enqueue('u1', kbId, [imported.accepted[0].id])
    await waitTerminal(imported.accepted[0].id)
  }

  it('MMR：近重复切片被压掉，第二位让给不重合的文档；关闭时两条都来自重复对', async () => {
    // 两篇近似重复（内容哈希不同、token 高度重合）；导入按内容哈希去重，不能写成完全一样
    await seedDoc('dup-a.md', '# 缓存预热\n缓存 预热 让 首次 请求 命中 内存 中的 数据，避免 重复 计算。')
    await seedDoc(
      'dup-b.md',
      '# 缓存预热\n缓存 预热 让 首次 请求 命中 内存 中的 数据，避免 重复 计算。\n补充：缓存 预热 也 降低 延迟。'
    )
    await seedDoc('other.md', '# 数据库\n数据库 索引 重建 需要 先 清空 旧 数据。')
    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })
    const query = '缓存 预热 内存 命中'

    // 关闭（默认）：top2 全被近重复对占据
    const off = await makeRetrieval(embedder).retrieve({ userId: 'u1', kbId, query, topK: 2 })
    expect(off.debug).toBeUndefined()
    expect(new Set(off.hits.map((hit) => hit.docName))).toEqual(new Set(['dup-a.md', 'dup-b.md']))

    // 开启（低 λ 偏多样性）：重复对只保留一条，第二位换成不重合的 other.md
    const on = await makeRetrieval(embedder, { mmrEnabled: true, mmrLambda: 0.2 }).retrieve({
      userId: 'u1',
      kbId,
      query,
      topK: 2
    })
    const names = on.hits.map((hit) => hit.docName)
    expect(names).toContain('other.md')
    expect(names.filter((name) => name.startsWith('dup-'))).toHaveLength(1)
  })

  it('时间衰减：半衰期 365 天让新文档反超；关闭时保持原序', async () => {
    const base = '# 衰减测试\n衰减 测试 词 用于 验证 导入 时间 加权。'
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(now - 365 * day)
      await seedDoc('old.md', base)
      vi.setSystemTime(now)
      // 与老文档近似但哈希不同（导入按内容哈希去重）；多出的标记只影响边缘分数
      await seedDoc('new.md', `${base}\n（新）`)
    } finally {
      vi.useRealTimers()
    }

    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })
    const query = '衰减 测试'
    // 关闭：同分同序（先导入的在前）
    const off = await makeRetrieval(embedder).retrieve({ userId: 'u1', kbId, query, topK: 2 })
    expect(off.hits[0].docName).toBe('old.md')
    expect(typeof off.hits[0].uploadedAt).toBe('number')

    // 开启：老文档打 0.5 折后让位
    const on = await makeRetrieval(embedder, { timeDecayHalfLifeDays: 365 }).retrieve({
      userId: 'u1',
      kbId,
      query,
      topK: 2
    })
    expect(on.hits[0].docName).toBe('new.md')
  })

  it('调试载荷：debug:true 返回分阶段耗时与通道统计；默认不带', async () => {
    await seedDoc('debug.md', '# 缓存预热\n缓存 预热 让 首次 请求 命中 内存 中的 数据。')
    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })
    const service = makeRetrieval(embedder)
    const query = '缓存 预热'

    const plain = await service.retrieve({ userId: 'u1', kbId, query })
    expect(plain.debug).toBeUndefined()

    const traced = await service.retrieve({ userId: 'u1', kbId, query, debug: true })
    const debug = traced.debug
    expect(debug).toBeTruthy()
    expect(debug!.topK).toBe(12)
    expect(debug!.timings.map((row) => row.stage)).toEqual([
      'rewrite',
      'recall',
      'fuse',
      'fetch',
      'merge',
      'rerank',
      'decay',
      'mmr',
      'total'
    ])
    for (const row of debug!.timings) expect(row.ms).toBeGreaterThanOrEqual(0)
    expect(debug!.channels.sparse.candidates).toBeGreaterThan(0)
    expect(debug!.denseGate).toBeNull()
    expect(debug!.flags.mmrApplied).toBe(false)
    expect(debug!.flags.decayApplied).toBe(false)
    expect(debug!.hits.length).toBe(traced.hits.length)
    expect(debug!.variants).toEqual([query])
  })

  it('多轮改写：改写器读到 history 才产变体；无历史时追问保持为空', async () => {
    await seedDoc(
      'cold-start.md',
      '# 冷启动优化\n冷启动 预热 机制 可以 显著 降低 首次 打开 的 等待 时间。'
    )
    const embedder = new EmbeddingProvider({ store, transport: makeTransport().transport })
    const rewriter = {
      available: (config: { queryRewriteEnabled: boolean }) => config.queryRewriteEnabled,
      rewrite: async (
        _query: string,
        _config: unknown,
        options?: { history?: Array<{ role: string; content: string }> }
      ): Promise<string[]> => (options?.history?.length ? ['冷启动 预热'] : [])
    }
    const service = new RetrievalService({
      store,
      sparse,
      settings: settingsStub({ ...GATED, queryRewriteEnabled: true }),
      getGlobalSettings: () => GLOBAL,
      embedder,
      queryRewriter: rewriter
    })

    // 无历史：改写器不产变体，原问题（它/的/缺点/呢）零命中
    const without = await service.retrieve({ userId: 'u1', kbId, query: '它的缺点呢' })
    expect(without.hits).toEqual([])

    // 带历史：改写器补全指代 → 变体命中
    const withHistory = await service.retrieve({
      userId: 'u1',
      kbId,
      query: '它的缺点呢',
      history: [
        { role: 'user', content: '冷启动优化是什么' },
        { role: 'assistant', content: '一种降低首次打开等待时间的机制' }
      ]
    })
    expect(withHistory.hits.length).toBeGreaterThan(0)
    expect(withHistory.hits[0].docName).toBe('cold-start.md')
  })
})
