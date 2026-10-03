import type { KnowledgeStore } from './KnowledgeStore'
import type { KnowledgeFileService } from './KnowledgeFileService'
import type { KnowledgeSettingsService } from './KnowledgeSettingsService'
import type { ChunkingService } from './ChunkingService'
import type { SparseIndexer } from './SparseIndexer'
import {
  indexSignature,
  overlaySnapshot,
  pickIndexSnapshot,
  toEngineConfig,
  type KnowledgeEngineConfig
} from './knowledge-config'
import type {
  KnowledgeDocStatus,
  KnowledgeIndexProgress,
  KnowledgeIndexStage
} from './types'

/**
 * 索引编排：串行队列 + 阶段状态机 + 进度事件 + 取消/重试 + 启动恢复。
 *
 * 设计要点：
 * - **串行（并发 1）**：本地磁盘 + 主进程 CPU，串行最稳；同 docId 去重，避免重复建索引。
 * - **先写库、后推事件**：每个阶段先更新 `knowledge_base_documents` 再发进度，
 *   渲染层刷新列表与事件两条路径看到的状态一致。
 * - **单文档失败隔离**：一篇失败写 `error_message` 后继续队列中其它文档。
 * - **写入原子**：切片/稀疏/向量在一个 SQLite 事务里落库（见 KnowledgeStore.replaceDocumentIndex），
 *   中途失败不会留下半截索引；取消发生在写库之前则旧索引原样保留。
 */

/** 阶段 → 进度（对齐 web 后端与设计文档的状态机口径） */
const STAGE_PROGRESS: Record<KnowledgeIndexStage, number> = {
  queued: 0,
  parsing: 3,
  chunking: 15,
  embedding: 30,
  bm25: 55,
  extracting: 70,
  indexed: 100
}

/** 进度事件节流窗口（同一文档 200ms 内只推一次） */
const PROGRESS_THROTTLE_MS = 200

/**
 * 每处理多少个切片让出一次事件循环。
 *
 * 必要性（性能基准实测）：大文档（2MB ≈ 6500 切片）的「分词 + 写库」若一口气跑完，
 * 主进程会有数秒不回到事件循环 —— 定时器、IPC 与界面交互全部被挡住。
 * 让出用 `setTimeout(0)` 而不是 `setImmediate`：要让**定时器阶段**也能跑
 * （Electron 主进程的很多调度走定时器）。
 */
const YIELD_EVERY_CHUNKS = 256

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export interface KnowledgeEmbedder {
  /** 该配置下嵌入端点是否可用（不可用则跳过向量化，走纯稀疏） */
  available: (config: KnowledgeEngineConfig) => boolean
  /** 批量向量化（内部负责分批/重试/缓存/维度校验与归一化；signal 用于取消） */
  embed: (
    texts: string[],
    config: KnowledgeEngineConfig,
    signal?: AbortSignal
  ) => Promise<Float32Array[]>
}

export interface KnowledgeGraphExtractor {
  /** 抽取该文档的实体/关系（失败抛错，由本服务记入 graph_error） */
  extract: (input: {
    userId: string
    kbId: string
    docId: string
    chunks: Array<{ id: number; index: number; content: string }>
    config: KnowledgeEngineConfig
    signal: AbortSignal
  }) => Promise<{ entities: number; relations: number }>
}

export interface KnowledgeIndexServiceDeps {
  store: KnowledgeStore
  files: KnowledgeFileService
  chunking: ChunkingService
  sparse: SparseIndexer
  settings: KnowledgeSettingsService
  /** 全局设置快照（补 4 个端点 key） */
  getGlobalSettings: () => Record<string, unknown>
  /** 向量化（P1 注入；缺省时纯稀疏索引） */
  embedder?: KnowledgeEmbedder
  /** 图谱抽取（P3 注入；缺省或未开启 graphEnabled 时跳过） */
  graph?: KnowledgeGraphExtractor
  onProgress?: (progress: KnowledgeIndexProgress) => void
}

interface IndexJob {
  userId: string
  kbId: string
  docId: string
  /** 重建：用当前生效配置刷新文档快照 */
  refreshConfig: boolean
  /** 只重跑图谱抽取（用已存切片；不重新解析/切片/向量化） */
  graphOnly?: boolean
}

/** 取消标记（AbortController 的 signal 会被传给图谱抽取等长任务） */
interface RunningJob {
  controller: AbortController
  /** 任务开始前的状态（取消时回退，避免「数据还在却显示未索引」） */
  previousStatus: KnowledgeDocStatus
}

export class KnowledgeIndexService {
  private readonly deps: KnowledgeIndexServiceDeps
  private readonly queue: IndexJob[] = []
  private readonly queued = new Set<string>()
  private readonly running = new Map<string, RunningJob>()
  private draining = false
  private disposed = false
  private lastEmitAt = 0

  constructor(deps: KnowledgeIndexServiceDeps) {
    this.deps = deps
  }

  /** 入队（同 docId 已在队列/运行中则跳过；返回实际入队数） */
  enqueue(
    userId: string,
    kbId: string,
    docIds: string[],
    options: { refreshConfig?: boolean; graphOnly?: boolean } = {}
  ): { queued: number } {
    if (this.disposed) return { queued: 0 }
    let count = 0
    for (const docId of docIds) {
      if (this.queued.has(docId) || this.running.has(docId)) continue
      this.queue.push({
        userId,
        kbId,
        docId,
        refreshConfig: options.refreshConfig === true,
        graphOnly: options.graphOnly === true
      })
      this.queued.add(docId)
      this.deps.store.updateDocumentIndexState(docId, {
        status: 'queued',
        stage: 'queued',
        progress: 0,
        errorMessage: null
      })
      count += 1
    }
    void this.drain()
    return { queued: count }
  }

  /** 取消排队与运行中的任务；省略 docIds = 取消全部 */
  cancel(docIds?: string[]): { canceled: number } {
    const targets = docIds ? new Set(docIds) : null
    let canceled = 0
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const job = this.queue[i]
      if (targets && !targets.has(job.docId)) continue
      this.queue.splice(i, 1)
      this.queued.delete(job.docId)
      this.deps.store.updateDocumentIndexState(job.docId, {
        status: 'none',
        stage: null,
        progress: 0
      })
      canceled += 1
    }
    for (const [docId, running] of this.running) {
      if (targets && !targets.has(docId)) continue
      running.controller.abort()
      canceled += 1
    }
    return { canceled }
  }

  /** 运行中或排队中的文档数（概览用） */
  pendingCount(): number {
    return this.queue.length + this.running.size
  }

  isActive(docId: string): boolean {
    return this.queued.has(docId) || this.running.has(docId)
  }

  /** 启动恢复：把上次退出时残留的 queued/indexing 置为 failed */
  recoverOnStartup(): number {
    return this.deps.store.recoverInterruptedIndexing()
  }

  /** 退出清理：停止消费并中止运行中的任务 */
  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    this.queued.clear()
    for (const running of this.running.values()) running.controller.abort()
  }

  // ── 队列消费 ──

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift() as IndexJob
        this.queued.delete(job.docId)
        try {
          await this.process(job)
        } catch (err) {
          // process 内部已兜底写 failed；这里的兜底只防意外逃逸
          console.error('[knowledge-index] job failed:', err)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async process(job: IndexJob): Promise<void> {
    const store = this.deps.store
    const doc = store.getDocumentById(job.docId)
    if (!doc || doc.userId !== job.userId || doc.kbId !== job.kbId) {
      // 文档已被删除/不属于该用户：静默出队
      return
    }
    if (doc.indexState === 'none') {
      // 只上传文件的文档被误入队：不索引
      return
    }

    const controller = new AbortController()
    this.running.set(job.docId, { controller, previousStatus: doc.status })
    const emit = (stage: KnowledgeIndexStage, extra: Partial<KnowledgeIndexProgress> = {}): void => {
      const now = Date.now()
      const isTerminal = stage === 'indexed'
      if (!isTerminal && now - this.lastEmitAt < PROGRESS_THROTTLE_MS) return
      this.lastEmitAt = now
      this.deps.onProgress?.({
        kbId: job.kbId,
        docId: job.docId,
        relPath: doc.relPath,
        status: 'indexing',
        stage,
        progress: STAGE_PROGRESS[stage],
        chunks: doc.chunksCount,
        entities: doc.entitiesCount,
        relations: doc.relationsCount,
        ...extra
      })
    }

    try {
      // ── 配置：全局 ← 按库（重建时以当前生效配置为准并刷新快照；首次索引尊重导入快照）──
      const global = this.deps.getGlobalSettings()
      const effective = this.deps.settings.getEffective(job.userId, job.kbId).effective
      let config = toEngineConfig(effective, global)
      if (job.refreshConfig) {
        store.updateDocumentConfig(doc.id, pickIndexSnapshot(config))
      } else {
        config = overlaySnapshot(config, doc.config)
      }

      // ── 只重抽图谱（用已存切片，不重新解析/切片/向量化）──
      if (job.graphOnly) {
        await this.runGraphStage({
          docId: doc.id,
          userId: doc.userId,
          kbId: doc.kbId,
          relPath: doc.relPath,
          chunks: store.listChunksForDoc(doc.id),
          config,
          signal: controller.signal,
          emit
        })
        store.recountBaseIndex(doc.kbId)
        return
      }

      // ── parsing ──
      this.enterStage(doc.id, 'parsing')
      emit('parsing')
      const full = await this.deps.files.readDocumentFullText(doc)
      this.assertNotAborted(controller)
      store.updateDocumentIndexState(doc.id, {
        charCount: full.charCount,
        truncated: full.truncated
      })

      await yieldToEventLoop()
      // ── chunking ──
      this.enterStage(doc.id, 'chunking')
      emit('chunking')
      const embedder = this.deps.embedder
      const embeddingAvailable = Boolean(embedder && embedder.available(config))
      const chunkResult = await this.deps.chunking.split(full.text, {
        strategy: config.chunkStrategy,
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
        embedSentences: embeddingAvailable
          ? (sentences) => (embedder as KnowledgeEmbedder).embed(sentences, config, controller.signal)
          : undefined
      })
      this.assertNotAborted(controller)
      if (!chunkResult.chunks.length) {
        // 解析不出文本（扫描件等）：明确失败，不再往下走
        throw new Error('未从文档中解析出可用于索引的文本')
      }

      // ── embedding ──
      let vectors: Float32Array[] | null = null
      let embeddingUsed = false
      if (embeddingAvailable && embedder) {
        this.enterStage(doc.id, 'embedding')
        emit('embedding')
        vectors = await embedder.embed(
          chunkResult.chunks.map((chunk) => chunk.content),
          config,
          controller.signal
        )
        embeddingUsed = true
        this.assertNotAborted(controller)
      }

      await yieldToEventLoop()
      // ── bm25（写库：切片 + 稀疏 + 向量，单事务）──
      this.enterStage(doc.id, 'bm25')
      emit('bm25')
      // 分词是大文档里最长的纯 CPU 段：分批算、批间让出，避免整段霸占主进程
      const tokens: string[] = []
      for (let index = 0; index < chunkResult.chunks.length; index += 1) {
        tokens.push(this.deps.sparse.tokenize(chunkResult.chunks[index].content))
        if ((index + 1) % YIELD_EVERY_CHUNKS === 0) {
          this.assertNotAborted(controller)
          await yieldToEventLoop()
        }
      }
      // 写入器逐批推进：每批之后让出事件循环（2MB 单文档 ≈ 6500 切片，
      // 一口气写会让主进程 ~700ms 不响应）
      const writer = store.createDocumentIndexWriter({
        docId: doc.id,
        kbId: doc.kbId,
        userId: doc.userId,
        chunks: chunkResult.chunks,
        tokens,
        vectors,
        vectorDim: vectors ? config.vectorDimensions : null,
        vectorModel: vectors ? config.embeddingModel : null
      })
      while (!writer.done) {
        writer.writeNextBatch()
        this.assertNotAborted(controller)
        await yieldToEventLoop()
      }
      const written = writer.written
      store.updateDocumentIndexState(doc.id, { chunksCount: written })
      this.assertNotAborted(controller)

      // ── extracting（图谱，可选；失败不阻断）──
      const graphOutcome = config.graphEnabled
        ? await this.runGraphStage({
            docId: doc.id,
            userId: doc.userId,
            kbId: doc.kbId,
            relPath: doc.relPath,
            chunks: store.listChunksForDoc(doc.id),
            config,
            signal: controller.signal,
            emit
          })
        : { entities: 0, relations: 0, graphError: null as string | null }
      const entities = graphOutcome.entities
      const relations = graphOutcome.relations
      const graphError = graphOutcome.graphError

      // ── indexed ──
      const signature = indexSignature(config, embeddingUsed)
      store.updateDocumentIndexState(doc.id, {
        status: 'indexed',
        stage: 'indexed',
        progress: 100,
        chunksCount: written,
        entitiesCount: entities,
        relationsCount: relations,
        graphError,
        indexSignature: signature,
        indexedAt: Date.now(),
        errorMessage: null
      })
      store.recountBaseIndex(doc.kbId)
      this.deps.onProgress?.({
        kbId: job.kbId,
        docId: doc.id,
        relPath: doc.relPath,
        status: 'indexed',
        stage: 'indexed',
        progress: 100,
        chunks: written,
        entities,
        relations,
        warning: graphError ? `图谱抽取失败：${graphError}` : chunkResult.warning
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const wasCanceled = controller.signal.aborted
      if (wasCanceled) {
        const previous = this.running.get(job.docId)?.previousStatus ?? 'none'
        // 取消：回退到任务前状态（索引数据未被改动，状态与数据保持一致）
        store.updateDocumentIndexState(doc.id, {
          status: previous === 'indexing' ? 'none' : previous,
          stage: null,
          progress: 0
        })
      } else {
        store.updateDocumentIndexState(doc.id, {
          status: 'failed',
          stage: null,
          errorMessage: message
        })
        this.deps.onProgress?.({
          kbId: job.kbId,
          docId: doc.id,
          relPath: doc.relPath,
          status: 'failed',
          stage: 'queued',
          progress: 0,
          chunks: 0,
          entities: 0,
          relations: 0,
          error: message
        })
      }
    } finally {
      this.running.delete(job.docId)
    }
  }

  /**
   * 图谱抽取阶段（首次索引与「重抽图谱」共用）。
   *
   * 失败**绝不静默**：错误写进 `graph_error`，文档保持 indexed；
   * 已抽到的部分已经落库（GraphService 先落库后抛错），可按篇重抽补齐。
   */
  private async runGraphStage(input: {
    docId: string
    userId: string
    kbId: string
    relPath: string
    chunks: Array<{ id: number; index: number; content: string }>
    config: KnowledgeEngineConfig
    signal: AbortSignal
    emit: (stage: KnowledgeIndexStage, extra?: Partial<KnowledgeIndexProgress>) => void
  }): Promise<{ entities: number; relations: number; graphError: string | null }> {
    const store = this.deps.store
    if (!this.deps.graph) {
      return { entities: 0, relations: 0, graphError: null }
    }
    this.enterStage(input.docId, 'extracting')
    input.emit('extracting')
    try {
      const outcome = await this.deps.graph.extract({
        userId: input.userId,
        kbId: input.kbId,
        docId: input.docId,
        chunks: input.chunks,
        config: input.config,
        signal: input.signal
      })
      store.updateDocumentIndexState(input.docId, {
        entitiesCount: outcome.entities,
        relationsCount: outcome.relations,
        graphError: null
      })
      this.deps.onProgress?.({
        kbId: input.kbId,
        docId: input.docId,
        relPath: input.relPath,
        status: 'indexed',
        stage: 'indexed',
        progress: 100,
        chunks: store.countChunks(input.kbId),
        entities: outcome.entities,
        relations: outcome.relations
      })
      return { ...outcome, graphError: null }
    } catch (err) {
      const graphError = err instanceof Error ? err.message : String(err)
      if (input.signal.aborted) throw err
      // 已落库部分可能仍有实体：回写真实计数 + 错误
      const counts = store.countDocumentGraph(input.docId)
      store.updateDocumentIndexState(input.docId, {
        entitiesCount: counts.entities,
        relationsCount: counts.relations,
        graphError
      })
      this.deps.onProgress?.({
        kbId: input.kbId,
        docId: input.docId,
        relPath: input.relPath,
        status: 'indexed',
        stage: 'indexed',
        progress: 100,
        chunks: store.countChunks(input.kbId),
        entities: counts.entities,
        relations: counts.relations,
        warning: `图谱抽取失败：${graphError}`
      })
      return { entities: counts.entities, relations: counts.relations, graphError }
    }
  }

  private enterStage(docId: string, stage: KnowledgeIndexStage): void {
    this.deps.store.updateDocumentIndexState(docId, {
      status: 'indexing',
      stage,
      progress: STAGE_PROGRESS[stage]
    })
  }

  private assertNotAborted(controller: AbortController): void {
    if (controller.signal.aborted) throw new Error('已取消')
  }
}
