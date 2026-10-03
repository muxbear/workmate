import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChunkingService } from '../../../src/main/knowledge/ChunkingService'
import { EmbeddingProvider, type EmbeddingTransport } from '../../../src/main/knowledge/EmbeddingProvider'
import { GraphService, type GraphChatModel } from '../../../src/main/knowledge/GraphService'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeIndexService } from '../../../src/main/knowledge/KnowledgeIndexService'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { RetrievalService } from '../../../src/main/knowledge/RetrievalService'
import { SparseIndexer } from '../../../src/main/knowledge/SparseIndexer'
import type { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'

/**
 * 检索质量评测（golden set 门禁）。
 *
 * 语料与金标集在 `tests/kb_eval/`：corpus.jsonl（7 篇文档）+ golden.jsonl（12 条查询，
 * 分 keyword / semantic / graph / multi / negative 五类）。
 *
 * 用**确定性替身**跑全链路（假嵌入 + 假抽取），因此结果可复现、零外部依赖；
 * 指标门槛写死在用例里，检索链路回归会直接变红。
 * 前提：better-sqlite3 需切换到 Node ABI。
 */

const nodeRequire = createRequire(import.meta.url)
const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath: () => string }

const DIM = 1024
const EVAL_DIR = join(__dirname, '..', '..', 'kb_eval')
const TOP_K = 5

/** 指标门槛（低于即回归） */
const THRESHOLDS = { hitAtK: 0.9, hitAt1: 0.7, negativePass: 1 }

interface CorpusDoc {
  id: string
  name: string
  content: string
}
interface GoldenCase {
  id: string
  category: string
  query: string
  expect_docs: string[]
}

function readJsonl<T>(file: string): T[] {
  return readFileSync(join(EVAL_DIR, file), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

const corpus = readJsonl<CorpusDoc>('corpus.jsonl')
const golden = readJsonl<GoldenCase>('golden.jsonl')

/** 同义词归一（与集成测试同一套替身口径）：让「动力装置」这类字面不相交的查询可语义命中 */
const SYNONYMS: Record<string, string> = {
  // 整短语优先（正则交替按书写顺序匹配）：体现「零字面重叠 → 同义映射」的语义召回
  动力装置: '向量存储选型',
  怎么把检索结果重新打分: '重排 融合',
  智能体读取命中片段的方式: '会话 智能体 命中片段 子智能体',
  检索时关键词和语义怎么结合: '关键词 语义 融合',
  索引失败之后怎么补救: '抽取失败 图谱错误 重抽'
}

function stubVector(text: string): Float32Array {
  const normalized = String(text).replace(/[一-龥]+/g, (token) => SYNONYMS[token] ?? token)
  const vector = new Float32Array(DIM)
  for (const unit of normalized.match(/[一-鿿]|[a-z0-9]+/gi) ?? []) {
    let hash = 0
    for (const char of unit) hash = (hash * 31 + char.codePointAt(0)!) % 100000
    vector[hash % DIM] += 1
  }
  let norm = 0
  for (let i = 0; i < DIM; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i += 1) vector[i] /= norm
  return vector
}

const dir = mkdtempSync(join(tmpdir(), 'ke-kb-eval-'))
let store: KnowledgeStore
let chunking: ChunkingService
let sparse: SparseIndexer
let retrieval: RetrievalService
let indexPathService: KnowledgeIndexService
let kbId = ''

/** 确定性「图谱替身」：按语料里出现的受控词表命中造实体与关系 */
const GRAPH_TERMS: Array<{ name: string; type: string }> = [
  { name: 'sqlite-vec', type: '产品' },
  { name: 'index.db', type: '产品' },
  { name: 'BM25', type: '算法' },
  { name: 'RRF', type: '算法' },
  { name: '知识图谱', type: '概念' },
  { name: '重排', type: '概念' },
  { name: '银河麒麟', type: '产品' },
  { name: '统信 UOS', type: '产品' },
  { name: '向量', type: '概念' },
  { name: '关键词', type: '概念' }
]

const graphModel: GraphChatModel = {
  extract: async ({ user }) => {
    const entities = GRAPH_TERMS.filter((term) => user.includes(term.name)).map((term) => ({
      ...term,
      source_text: term.name
    }))
    const names = new Set(entities.map((item) => item.name))
    const relations: Array<{ from: string; to: string; label: string; description: string }> = []
    if (names.has('sqlite-vec') && names.has('银河麒麟')) {
      relations.push({ from: 'sqlite-vec', to: '银河麒麟', label: '运行于', description: '' })
    }
    if (names.has('BM25') && names.has('RRF')) {
      relations.push({ from: 'BM25', to: 'RRF', label: '融合于', description: '' })
    }
    if (names.has('向量') && names.has('关键词')) {
      relations.push({ from: '向量', to: '关键词', label: '互补', description: '' })
    }
    return { entities, relations }
  }
}

const embedTransport: EmbeddingTransport = async ({ body }) => {
  const texts = (body as { input: string[] }).input
  return { data: texts.map((text, index) => ({ embedding: Array.from(stubVector(text)), index })) }
}

function settings(): KnowledgeSettingsService {
  return {
    getEffective: () => ({
      effective: {
        chunkStrategy: 'recursive',
        chunkSize: 120,
        chunkOverlap: 20,
        embeddingModel: 'stub-embed',
        vectorDimensions: DIM,
        sparseRetrieval: true,
        bm25K1: 1.5,
        bm25B: 0.75,
        hybridWeight: 0.65,
        rerankEnabled: false,
        minSimilarity: 0.3,
        queryRewriteEnabled: false,
        mmrEnabled: false,
        mmrLambda: 0.7,
        timeDecayHalfLifeDays: 0,
        graphEnabled: true,
        graphModel: 'stub-graph'
      },
      overridden: []
    })
  } as unknown as KnowledgeSettingsService
}

const GLOBAL = {
  'knowledge.embeddingBaseUrl': 'http://stub/v1',
  'knowledge.embeddingApiKey': 'sk-stub'
}

let hits: Record<string, string[]> = {}

beforeAll(async () => {
  store = new KnowledgeStore(() => dir)
  const files = new KnowledgeFileService(store, {
    getDir: () => dir,
    getLimits: () => ({ maxUploadSizeMB: 10, maxFilesPerBatch: 50, uploadTimeoutMinutes: 10 })
  })
  chunking = new ChunkingService()
  sparse = new SparseIndexer(store)
  store.loadVectorExtension(sqliteVec.getLoadablePath())
  store.ensureSparseIndex()
  store.ensureVectorTable(DIM)
  kbId = store.createBase('eval-user', { name: '评测语料', description: '', kind: 'local' }).id

  const embedder = new EmbeddingProvider({ store, transport: embedTransport })
  const graph = new GraphService({ store, resolveModel: async () => graphModel })
  indexPathService = new KnowledgeIndexService({
    store,
    files,
    chunking,
    sparse,
    settings: settings(),
    getGlobalSettings: () => GLOBAL,
    embedder,
    graph
  })
  retrieval = new RetrievalService({
    store,
    sparse,
    settings: settings(),
    getGlobalSettings: () => GLOBAL,
    embedder
  })

  // 落盘 + 入队 + 等全部完成
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  const docIds: string[] = []
  for (const doc of corpus) {
    const srcPath = join(srcDir, doc.name)
    writeFileSync(srcPath, doc.content, 'utf-8')
    const imported = files.importDocuments(
      'eval-user',
      kbId,
      [{ srcPath, relPath: doc.name }],
      'default'
    )
    docIds.push(imported.accepted[0].id)
  }
  indexPathService.enqueue('eval-user', kbId, docIds)
  const start = Date.now()
  for (;;) {
    const done = docIds.every((id) => {
      const doc = store.getDocumentById(id)
      return doc?.status === 'indexed' || doc?.status === 'failed'
    })
    if (done) break
    if (Date.now() - start > 60_000) throw new Error('评测语料索引超时')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  // 跑金标集
  hits = {}
  for (const item of golden) {
    const result = await retrieval.retrieve({
      userId: 'eval-user',
      kbId,
      query: item.query,
      topK: TOP_K
    })
    hits[item.id] = result.noRelevantResult ? [] : result.hits.map((hit) => hit.docName)
  }
}, 120_000)

afterAll(() => {
  store?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('检索质量评测（golden set 门禁）', () => {
  it('语料已全部建立索引（含向量与图谱）', () => {
    const docs = store.listDocuments('eval-user', kbId)
    expect(docs.every((doc) => doc.status === 'indexed')).toBe(true)
    expect(store.hasVectors(kbId)).toBe(true)
    expect(store.countGraphEntities(kbId)).toBeGreaterThan(0)
  })

  it(`Hit@${TOP_K} 与 Hit@1 达到门槛，negative 全部为空`, () => {
    const positives = golden.filter((item) => item.expect_docs.length > 0)
    const negatives = golden.filter((item) => item.expect_docs.length === 0)

    const hitAtK = positives.filter((item) =>
      item.expect_docs.some((doc) => (hits[item.id] ?? []).includes(doc))
    ).length
    const hitAt1 = positives.filter((item) => item.expect_docs.includes(hits[item.id]?.[0] ?? '')).length
    const negativePass = negatives.filter((item) => (hits[item.id] ?? []).length === 0).length

    const report = {
      generatedAt: new Date().toISOString(),
      topK: TOP_K,
      total: positives.length,
      hitAtK: hitAtK / positives.length,
      hitAt1: hitAt1 / positives.length,
      negativePass: negatives.length ? negativePass / negatives.length : 1,
      cases: golden.map((item) => ({
        id: item.id,
        category: item.category,
        query: item.query,
        expect: item.expect_docs,
        got: (hits[item.id] ?? []).slice(0, 3),
        hit: item.expect_docs.length
          ? item.expect_docs.some((doc) => (hits[item.id] ?? []).includes(doc))
          : (hits[item.id] ?? []).length === 0
      }))
    }
    writeFileSync(join(EVAL_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')

    console.log(
      `[kb-eval] Hit@${TOP_K}=${report.hitAtK.toFixed(2)} Hit@1=${report.hitAt1.toFixed(2)} negative=${report.negativePass.toFixed(2)}`
    )
    for (const item of report.cases.filter((entry) => !entry.hit)) {
      console.log(`[kb-eval] 未命中 ${item.id}(${item.category}) 「${item.query}」 期望=${item.expect} 实际=${item.got}`)
    }

    expect(report.hitAtK).toBeGreaterThanOrEqual(THRESHOLDS.hitAtK)
    expect(report.hitAt1).toBeGreaterThanOrEqual(THRESHOLDS.hitAt1)
    expect(report.negativePass).toBeGreaterThanOrEqual(THRESHOLDS.negativePass)
  })
})
