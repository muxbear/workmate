import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChunkingService } from '../../../src/main/knowledge/ChunkingService'
import { EmbeddingProvider, type EmbeddingTransport } from '../../../src/main/knowledge/EmbeddingProvider'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeIndexService } from '../../../src/main/knowledge/KnowledgeIndexService'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { SparseIndexer } from '../../../src/main/knowledge/SparseIndexer'
import type { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'

/**
 * 索引性能基准（事件循环阻塞 = 「超大库首建时 UI 会不会卡」的直接指标）。
 *
 * 做法：造一批合成文档（默认 60 篇 × ~24KB ≈ 1.4MB 文本、约 2000+ 切片），走完整
 * 索引管线（解析→切片→向量化替身→FTS5 分词写入→vec0 写入），期间用
 * `monitorEventLoopDelay` 采样事件循环延迟。
 *
 * 门槛（回归用，不是绝对性能承诺）：
 * - 单次最长阻塞 < 1500ms（超过说明主进程被同步工作占住，UI 会明显卡顿）；
 * - 总耗时 < 60s（1.4MB 语料，含 2000+ 切片的 FTS/向量写入）。
 *
 * 实测结论会打印出来——它是「要不要上 worker_threads」的判据（见方案文档 §10.1）。
 * 前提：better-sqlite3 需切换到 Node ABI。
 */

const nodeRequire = createRequire(import.meta.url)
const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath: () => string }

const DIM = 256 // 基准用窄向量：只关心主进程侧 CPU/IO 阻塞，不关心向量宽度
const DOC_COUNT = 60
/** 单篇目标体积（字符） */
const DOC_CHARS = 24_000

const dir = mkdtempSync(join(tmpdir(), 'ke-kb-perf-'))
let store: KnowledgeStore
let service: KnowledgeIndexService
let kbId = ''
const docIds: string[] = []

function stubVector(text: string, dim: number): Float32Array {
  const vector = new Float32Array(dim)
  for (const unit of text.match(/[一-鿿]|[a-z0-9]+/gi) ?? []) {
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

const transport: EmbeddingTransport = async ({ body }) => {
  const texts = (body as { input: string[] }).input
  return { data: texts.map((text, index) => ({ embedding: Array.from(stubVector(text, DIM)), index })) }
}

function settings(): KnowledgeSettingsService {
  return {
    getEffective: () => ({
      effective: {
        chunkStrategy: 'recursive',
        chunkSize: 300,
        chunkOverlap: 30,
        embeddingModel: 'stub-embed',
        vectorDimensions: DIM,
        sparseRetrieval: true,
        bm25K1: 1.5,
        bm25B: 0.75,
        hybridWeight: 0.65,
        rerankEnabled: false,
        minSimilarity: 0,
        graphEnabled: false,
        graphModel: ''
      },
      overridden: []
    })
  } as unknown as KnowledgeSettingsService
}

const GLOBAL = {
  'knowledge.embeddingBaseUrl': 'http://stub/v1',
  'knowledge.embeddingApiKey': 'sk-stub'
}

let report = {
  docs: 0,
  probeSelfCheckMs: 0,
  chunks: 0,
  totalMs: 0,
  maxBlockMs: 0,
  p99BlockMs: 0,
  meanBlockMs: 0
}

beforeAll(async () => {
  store = new KnowledgeStore(() => dir)
  const files = new KnowledgeFileService(store, {
    getDir: () => dir,
    getLimits: () => ({ maxUploadSizeMB: 10, maxFilesPerBatch: 200, uploadTimeoutMinutes: 60 })
  })
  const chunking = new ChunkingService()
  const sparse = new SparseIndexer(store)
  store.loadVectorExtension(sqliteVec.getLoadablePath())
  store.ensureSparseIndex()
  store.ensureVectorTable(DIM)
  kbId = store.createBase('perf', { name: '性能基准', description: '', kind: 'local' }).id
  service = new KnowledgeIndexService({
    store,
    files,
    chunking,
    sparse,
    settings: settings(),
    getGlobalSettings: () => GLOBAL,
    embedder: new EmbeddingProvider({ store, transport })
  })

  // 造语料：每篇 24KB，段落式中文（贴近真实文档的重复度与标点分布）
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  const paragraph = '这一段用于性能基准测试，包含中文标点、英文术语 RAG 与数字 2026，以及足够的长度来触发多切片。'
  for (let index = 0; index < DOC_COUNT; index += 1) {
    const body = `${paragraph.repeat(Math.ceil(DOC_CHARS / paragraph.length))}`
    const name = `bench-${String(index).padStart(3, '0')}.md`
    const srcPath = join(srcDir, name)
    writeFileSync(srcPath, `# 性能文档 ${index}\n${body}`, 'utf-8')
    const imported = files.importDocuments('perf', kbId, [{ srcPath, relPath: name }], 'default')
    docIds.push(imported.accepted[0].id)
  }
  // 最坏情况：单篇 2MB（索引侧 readDocumentFullText 的文本上限）→ 两三千个切片的
  // FTS/向量写入落在**同一个同步事务**里，这是主进程最长的一次阻塞
  const bigPath = join(srcDir, 'bench-big.md')
  writeFileSync(bigPath, `# 大文档\n${paragraph.repeat(Math.ceil(2_000_000 / paragraph.length))}`, 'utf-8')
  const bigImported = files.importDocuments(
    'perf',
    kbId,
    [{ srcPath: bigPath, relPath: 'bench-big.md' }],
    'default'
  )
  docIds.push(bigImported.accepted[0].id)

  // 采样事件循环延迟：1ms 分辨率直方图 + 5ms 心跳探针（探针直接给出「最长阻塞」）
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  let lastTick = performance.now()
  let probeMaxGapMs = 0
  const probe = setInterval(() => {
    const now = performance.now()
    probeMaxGapMs = Math.max(probeMaxGapMs, now - lastTick - 5)
    lastTick = now
  }, 5)
  const started = performance.now()
  service.enqueue('perf', kbId, docIds)
  for (;;) {
    const done = docIds.every((id) => {
      const doc = store.getDocumentById(id)
      return doc?.status === 'indexed' || doc?.status === 'failed'
    })
    if (done) break
    if (performance.now() - started > 120_000) throw new Error('性能基准索引超时')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const totalMs = performance.now() - started
  // 索引期的最长阻塞（此刻还没有自检的空转干扰）
  const indexMaxBlockMs = Math.round(Math.max(probeMaxGapMs, histogram.max / 1e6))
  // 探针自检：故意同步阻塞 150ms，探针必须能测到（否则这个指标不可信）
  const busyStart = performance.now()
  while (performance.now() - busyStart < 150) {
    /* 空转 */
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  const probeSelfCheckMs = Math.round(probeMaxGapMs)
  clearInterval(probe)
  histogram.disable()

  report = {
    docs: DOC_COUNT,
    chunks: store.countChunks(kbId),
    totalMs: Math.round(totalMs),
    probeSelfCheckMs,
    maxBlockMs: indexMaxBlockMs,
    p99BlockMs: Math.round(histogram.percentile(99) / 1e6),
    meanBlockMs: Math.round((histogram.mean / 1e6) * 10) / 10
  }
  console.log('[kb-perf]', JSON.stringify(report))
}, 180_000)

afterAll(() => {
  store?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('索引性能基准（事件循环阻塞）', () => {
  it('全部文档索引成功', () => {
    const docs = store.listDocuments('perf', kbId)
    const failed = docs.filter((doc) => doc.status !== 'indexed')
    expect(failed.map((doc) => `${doc.relPath}:${doc.errorMessage}`)).toEqual([])
    expect(report.chunks).toBeGreaterThan(500)
  })

  it('探针自检：150ms 的同步阻塞必须能测到（指标本身可信）', () => {
    expect(report.probeSelfCheckMs).toBeGreaterThanOrEqual(150)
  })

  it('索引期单次事件循环阻塞 < 600ms（当前实测 ~285ms，2MB 大文档的切片调用）', () => {
    expect(report.maxBlockMs).toBeLessThan(600)
  })

  it('3.4MB 语料全量索引 < 60s', () => {
    expect(report.totalMs).toBeLessThan(60_000)
  })
})
