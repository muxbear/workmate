import type { KnowledgeStore } from './KnowledgeStore'
import type { KnowledgeSettingsService } from './KnowledgeSettingsService'
import type { SparseIndexer } from './SparseIndexer'
import type { KnowledgeEmbedder } from './KnowledgeIndexService'
import { toEngineConfig, type KnowledgeEngineConfig } from './knowledge-config'
import { selectMmr, type MmrCandidate } from './mmr'
import { applyTimeDecay, decayFactor } from './time-decay'
import type {
  KnowledgeHit,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  RetrievalDebugInfo,
  RetrievalDebugStage,
  RetrievalHistoryTurn
} from './types'

/**
 * 检索服务：页面问答（2-Step RAG）、会话 kb_search 工具（Agentic RAG）共用同一条链路。
 *
 * 管线（顺序不可交换）：
 *   召回（FTS5 BM25 ‖ vec0 KNN）→ 加权 RRF 融合 → 相邻块合并去重 → 重排（可选）
 *   → 时间衰减（可选）→ MMR 去冗余（可选）→ topK 截断
 *
 * 顺序约束（改这里前先读）：
 * - 衰减必须在重排**之后**（重排直接覆写 score，先衰减会被抹掉）；
 * - 衰减必须在合并**之后**（合并的贪心分组依赖分数排序）；
 * - MMR 必须在截断**之前**（要为 topK 做取舍）。
 *
 * 降级语义（任何一路不可用都不阻断检索，只回传标记让 UI 轻提示）：
 * - 未配置嵌入端点 / 库内没有向量 → `vectorSkipped`
 * - `sparseRetrieval=false` → `sparseSkipped`
 * - 未启用重排或端点不可用 → `rerankSkipped`
 * - 两路都不可用（无效组合）→ 直接报错，指引去设置页开启稀疏检索
 */

/** RRF 常数（与 web 后端一致） */
const RRF_K = 60
/** 候选池倍数：重排开启时多取一些给重排模型留出腾挪空间 */
const CANDIDATE_MULTIPLIER_RERANK = 3
const CANDIDATE_MULTIPLIER_PLAIN = 2
/** MMR 开启时的候选池倍数（去冗余要有多余候选才谈得上取舍；无 API 成本） */
const MMR_CANDIDATE_MULTIPLIER = 4

export interface KnowledgeReranker {
  /** 可用性（未配置端点/模型时为 false） */
  available: (config: KnowledgeEngineConfig) => boolean
  /** 返回与 docs 等长的相关性分数；失败返回 null（调用方降级） */
  rerank: (
    query: string,
    docs: string[],
    config: KnowledgeEngineConfig
  ) => Promise<number[] | null>
}

export interface RetrievalServiceDeps {
  store: KnowledgeStore
  sparse: SparseIndexer
  settings: KnowledgeSettingsService
  getGlobalSettings: () => Record<string, unknown>
  embedder?: KnowledgeEmbedder
  reranker?: KnowledgeReranker
  /** 查询改写（Hybrid RAG 的 query enhancement；默认关闭，开启后多一次模型调用） */
  queryRewriter?: KnowledgeQueryRewriter
}

/** 检索侧的查询改写契约（生产为 QueryRewriter；单测注入替身） */
export interface KnowledgeQueryRewriter {
  available: (config: KnowledgeEngineConfig) => boolean
  /** 返回变体列表（不含原问题）；失败返回空数组。history 供代词式追问补全指代 */
  rewrite: (
    query: string,
    config: KnowledgeEngineConfig,
    options?: { history?: RetrievalHistoryTurn[] }
  ) => Promise<string[]>
}

/** 召回阶段的一条候选（融合前） */
interface Candidate {
  chunkId: number
  score: number
  rank: number
}

/** 单个改写变体的召回产物（stageRecall → stageFuse 之间传递） */
interface VariantRecall {
  candidates: FusedCandidate[]
  seedNames: string[]
  stats: VariantStats
}

/** 单次检索的运行状态（各 stage 依次读写；字段与阶段一一对应） */
interface RetrievalRun {
  // 输入与生效配置
  userId: string
  kbId: string
  query: string
  mode: KnowledgeSearchMode
  topK: number
  config: KnowledgeEngineConfig
  history?: RetrievalHistoryTurn[]
  // 通道可用性与候选池
  sparseAvailable: boolean
  denseAvailable: boolean
  candidateLimit: number
  // 各阶段产物
  variants: string[]
  perVariant: VariantRecall[]
  seedNames: string[]
  fused: FusedCandidate[]
  hits: KnowledgeHit[]
  rerankSkipped: boolean
  decayNow: number
  decayApplied: boolean
  mmrApplied: boolean
}

/**
 * 检索调试追踪器：把原先散在 retrieve() 内联的 trace/mark 插桩收拢为一处。
 * debug=false 时所有方法即时返回（零全局状态、零额外开销）；载荷形状由
 * hybrid-retrieval 集成测试钉死（阶段耗时 / 通道统计 / 门限 / flags / hits）。
 */
class RetrievalTracer {
  private readonly startedAt: number
  private lastMark: number
  private readonly timings: RetrievalDebugStage[] = []
  private readonly channels = { sparse: 0, dense: 0, graph: 0 }
  private readonly channelMs = { sparse: 0, dense: 0, graph: 0 }
  private gate: RetrievalDebugInfo['denseGate'] = null
  private variants: string[] = []

  constructor(readonly enabled: boolean) {
    this.startedAt = performance.now()
    this.lastMark = this.startedAt
  }

  /** 记录「距上一 mark」的阶段耗时（阶段边界即调用点，与旧内联实现一一对应） */
  mark(stage: RetrievalDebugStage['stage']): void {
    if (!this.enabled) return
    const now = performance.now()
    this.timings.push({ stage, ms: round2(now - this.lastMark) })
    this.lastMark = now
  }

  setVariants(variants: string[]): void {
    if (this.enabled) this.variants = variants
  }

  /** 汇总单个改写变体的通道候选数与耗时；门限信息取「失败并集 + 最高 topScore」 */
  recordVariant(stats: VariantStats): void {
    if (!this.enabled) return
    this.channels.sparse += stats.channels.sparse
    this.channels.dense += stats.channels.dense
    this.channels.graph += stats.channels.graph
    this.channelMs.sparse += stats.ms.sparse
    this.channelMs.dense += stats.ms.dense
    this.channelMs.graph += stats.ms.graph
    if (stats.gate) {
      this.gate = this.gate
        ? {
            ...this.gate,
            failed: this.gate.failed || stats.gate.failed,
            topScore: Math.max(this.gate.topScore, stats.gate.topScore)
          }
        : { ...stats.gate }
    }
  }

  /** 组装调试载荷（未启用返回 undefined，调用处条件展开） */
  finalize(extra: {
    mode: KnowledgeSearchMode
    topK: number
    candidateLimit: number
    vectorSkipped: boolean
    sparseSkipped: boolean
    fusedCount: number
    finalHits: KnowledgeHit[]
    rerankSkipped: boolean
    mmrApplied: boolean
    decayApplied: boolean
    decayNow: number
    timeDecayHalfLifeDays: number
  }): RetrievalDebugInfo | undefined {
    if (!this.enabled) return undefined
    return {
      mode: extra.mode,
      topK: extra.topK,
      candidateLimit: extra.candidateLimit,
      variants: this.variants,
      timings: [
        ...this.timings,
        { stage: 'total', ms: round2(performance.now() - this.startedAt) }
      ],
      channels: {
        sparse: { candidates: this.channels.sparse, ms: round2(this.channelMs.sparse) },
        dense: { candidates: this.channels.dense, ms: round2(this.channelMs.dense) },
        graph: { candidates: this.channels.graph, ms: round2(this.channelMs.graph) }
      },
      denseGate: this.gate,
      flags: {
        vectorSkipped: extra.vectorSkipped,
        sparseSkipped: extra.sparseSkipped,
        rerankSkipped: extra.rerankSkipped,
        mmrApplied: extra.mmrApplied,
        decayApplied: extra.decayApplied
      },
      fusedCount: extra.fusedCount,
      hits: extra.finalHits.map((hit) => ({
        chunkId: hit.chunkId,
        score: hit.score,
        vecScore: hit.vecScore,
        bm25Score: hit.bm25Score,
        source: hit.source,
        uploadedAt: hit.uploadedAt,
        ...(extra.decayApplied && extra.decayNow > 0
          ? {
              decayFactor: round4(
                decayFactor(hit.uploadedAt, extra.decayNow, extra.timeDecayHalfLifeDays)
              )
            }
          : {})
      }))
    }
  }
}

export class RetrievalService {
  private readonly deps: RetrievalServiceDeps

  constructor(deps: RetrievalServiceDeps) {
    this.deps = deps
  }

  /** 读取某库的生效检索配置（页面问答与会话工具共用） */
  effectiveConfig(userId: string, kbId: string): KnowledgeEngineConfig {
    return toEngineConfig(
      this.deps.settings.getEffective(userId, kbId).effective,
      this.deps.getGlobalSettings()
    )
  }

  async retrieve(input: {
    userId: string
    kbId: string
    query: string
    topK?: number
    mode?: KnowledgeSearchMode
    /** 最近几轮对话（可选）：只用于查询改写补全指代，不改变「检索只用本轮问题」 */
    history?: RetrievalHistoryTurn[]
    /** 收集分阶段耗时/各通道候选数（检索调试面板用；QA 与 agent 工具不传） */
    debug?: boolean
  }): Promise<KnowledgeSearchResult> {
    const query = String(input.query ?? '').trim()
    const config = this.effectiveConfig(input.userId, input.kbId)
    const mode: KnowledgeSearchMode = input.mode ?? 'hybrid'
    const topK = clampTopK(input.topK ?? config.topK)
    const tracer = new RetrievalTracer(input.debug === true)

    if (!query) {
      return {
        hits: [],
        vectorSkipped: mode === 'bm25',
        sparseSkipped: mode === 'vector',
        rerankSkipped: !config.rerankEnabled,
        noRelevantResult: true,
        ...(tracer.enabled ? { debug: emptyDebugInfo(mode, topK) } : {})
      }
    }

    const wantSparse = mode !== 'vector'
    const wantDense = mode !== 'bm25'
    const sparseAvailable = wantSparse && config.sparseRetrieval
    const denseAvailable =
      wantDense && Boolean(this.deps.embedder?.available(config)) && this.deps.store.hasVectors(input.kbId)

    if (!sparseAvailable && !denseAvailable) {
      throw new Error(
        mode === 'bm25' || config.sparseRetrieval === false
          ? '稀疏检索已关闭且向量检索不可用：请到「设置 → 知识库」开启稀疏检索或配置嵌入端点'
          : '当前检索方式不可用：请到「设置 → 知识库」检查检索配置'
      )
    }

    const run: RetrievalRun = {
      userId: input.userId,
      kbId: input.kbId,
      query,
      mode,
      topK,
      config,
      history: input.history,
      sparseAvailable,
      denseAvailable,
      candidateLimit:
        topK *
        (config.mmrEnabled
          ? MMR_CANDIDATE_MULTIPLIER
          : config.rerankEnabled
            ? CANDIDATE_MULTIPLIER_RERANK
            : CANDIDATE_MULTIPLIER_PLAIN),
      variants: [query],
      perVariant: [],
      seedNames: [],
      fused: [],
      hits: [],
      rerankSkipped: false,
      decayNow: 0,
      decayApplied: false,
      mmrApplied: false
    }

    await this.stageRewrite(run, tracer)
    await this.stageRecall(run, tracer)
    this.stageFuse(run, tracer)
    if (!run.fused.length) {
      // 召回到此为止就是空：如实标记「没有相关内容」，问答据此不编造
      const emptyRerankSkipped = !config.rerankEnabled || !this.deps.reranker?.available(config)
      return {
        hits: [],
        vectorSkipped: !run.denseAvailable,
        sparseSkipped: !run.sparseAvailable,
        rerankSkipped: emptyRerankSkipped,
        noRelevantResult: true,
        ...(tracer.enabled
          ? {
              debug: tracer.finalize({
                mode,
                topK,
                candidateLimit: run.candidateLimit,
                vectorSkipped: !run.denseAvailable,
                sparseSkipped: !run.sparseAvailable,
                fusedCount: 0,
                finalHits: [],
                rerankSkipped: emptyRerankSkipped,
                mmrApplied: false,
                decayApplied: false,
                decayNow: 0,
                timeDecayHalfLifeDays: config.timeDecayHalfLifeDays
              })!
            }
          : {})
      }
    }
    this.stageFetch(run, tracer)
    this.stageMerge(run, tracer)
    await this.stageRerank(run, tracer)
    this.stageDecay(run, tracer)
    this.stageMmr(run, tracer)

    const finalHits = run.hits.slice(0, topK)
    return {
      hits: finalHits,
      vectorSkipped: !run.denseAvailable,
      sparseSkipped: !run.sparseAvailable,
      rerankSkipped: run.rerankSkipped,
      noRelevantResult: finalHits.length === 0,
      ...(run.seedNames.length ? { graphEntities: run.seedNames } : {}),
      ...(tracer.enabled
        ? {
            debug: tracer.finalize({
              mode,
              topK,
              candidateLimit: run.candidateLimit,
              vectorSkipped: !run.denseAvailable,
              sparseSkipped: !run.sparseAvailable,
              fusedCount: run.fused.length,
              finalHits,
              rerankSkipped: run.rerankSkipped,
              mmrApplied: run.mmrApplied,
              decayApplied: run.decayApplied,
              decayNow: run.decayNow,
              timeDecayHalfLifeDays: config.timeDecayHalfLifeDays
            })!
          }
        : {})
    }
  }

  /** stage：查询改写（原文永远第一路；关闭或失败退化为只用原问题） */
  private async stageRewrite(run: RetrievalRun, tracer: RetrievalTracer): Promise<void> {
    run.variants = await this.expandQuery(run.query, run.config, run.history)
    tracer.setVariants(run.variants)
    tracer.mark('rewrite')
  }

  /** stage：多路召回（每个改写变体各跑一遍图扩展/稀疏/稠密并做通道内融合） */
  private async stageRecall(run: RetrievalRun, tracer: RetrievalTracer): Promise<void> {
    const perVariant = await Promise.all(
      run.variants.map((variant) =>
        this.collectVariant({
          userId: run.userId,
          kbId: run.kbId,
          query: variant,
          mode: run.mode,
          sparseAvailable: run.sparseAvailable,
          denseAvailable: run.denseAvailable,
          candidateLimit: run.candidateLimit,
          config: run.config
        })
      )
    )
    tracer.mark('recall')
    run.perVariant = perVariant
    run.seedNames = [...new Set(perVariant.flatMap((item) => item.seedNames))]
    for (const item of perVariant) tracer.recordVariant(item.stats)
  }

  /** stage：跨变体融合（单路直接用其融合结果；多路按排名做等权 RRF） */
  private stageFuse(run: RetrievalRun, tracer: RetrievalTracer): void {
    run.fused =
      run.perVariant.length <= 1
        ? (run.perVariant[0]?.candidates ?? [])
        : fuseVariants(
            run.perVariant.map((item) => item.candidates),
            run.candidateLimit
          )
    tracer.mark('fuse')
  }

  /** stage：取内容（JOIN 文档表；渲染层只拿 relPath/docName） */
  private stageFetch(run: RetrievalRun, tracer: RetrievalTracer): void {
    const details = this.deps.store.getChunksByIds(run.fused.map((item) => item.chunkId))
    const detailMap = new Map(details.map((detail) => [detail.chunkId, detail]))
    const hits: KnowledgeHit[] = []
    for (const item of run.fused) {
      const detail = detailMap.get(item.chunkId)
      if (!detail) continue
      hits.push({
        chunkUid: detail.uid,
        chunkId: detail.chunkId,
        docId: detail.docId,
        docName: detail.docName,
        relPath: detail.relPath,
        chunkIndex: detail.chunkIndex,
        heading: detail.heading ?? undefined,
        content: detail.content,
        score: item.score,
        vecScore: item.vecScore,
        bm25Score: item.bm25Score,
        source: item.source,
        charStart: detail.charStart,
        charEnd: detail.charEnd,
        uploadedAt: detail.uploadedAt
      })
    }
    run.hits = hits
    tracer.mark('fetch')
  }

  /** stage：相邻块合并去重（必须在衰减之前——合并的贪心分组依赖分数排序） */
  private stageMerge(run: RetrievalRun, tracer: RetrievalTracer): void {
    run.hits = mergeAdjacent(run.hits)
    tracer.mark('merge')
  }

  /** stage：重排（可选；失败/不可用只降级，保留融合顺序） */
  private async stageRerank(run: RetrievalRun, tracer: RetrievalTracer): Promise<void> {
    const { config } = run
    let rerankSkipped = !config.rerankEnabled
    if (config.rerankEnabled && this.deps.reranker?.available(config)) {
      const result = await this.deps.reranker
        .rerank(
          run.query,
          run.hits.slice(0, run.topK * CANDIDATE_MULTIPLIER_RERANK).map((hit) => hit.content),
          config
        )
        .catch(() => null)
      if (result) {
        const head = run.hits.slice(0, result.length)
        head.forEach((hit, index) => {
          hit.score = result[index]
        })
        head.sort((a, b) => b.score - a.score)
        run.hits = [...head, ...run.hits.slice(result.length)]
      } else {
        rerankSkipped = true
      }
    } else if (config.rerankEnabled) {
      rerankSkipped = true
    }
    run.rerankSkipped = rerankSkipped
    tracer.mark('rerank')
  }

  /** stage：时间衰减（可选；必须在重排之后——重排直接覆写 score，先衰减会被抹掉） */
  private stageDecay(run: RetrievalRun, tracer: RetrievalTracer): void {
    run.decayNow = Date.now()
    run.decayApplied = run.config.timeDecayHalfLifeDays > 0 && run.hits.length > 0
    run.hits = applyTimeDecay(run.hits, run.decayNow, run.config.timeDecayHalfLifeDays)
    tracer.mark('decay')
  }

  /** stage：MMR 去冗余（可选；必须在截断之前——要为 topK 做取舍） */
  private stageMmr(run: RetrievalRun, tracer: RetrievalTracer): void {
    run.mmrApplied = run.config.mmrEnabled && run.hits.length > run.topK
    if (run.mmrApplied) {
      run.hits = this.applyMmr(run.hits, run.topK, run.config.mmrLambda)
    }
    tracer.mark('mmr')
  }

  /** 查询改写：关闭或失败时只返回原问题（history 仅供改写补全指代，原文永远第一路） */
  private async expandQuery(
    query: string,
    config: KnowledgeEngineConfig,
    history?: RetrievalHistoryTurn[]
  ): Promise<string[]> {
    const rewriter = this.deps.queryRewriter
    if (!rewriter?.available(config)) return [query]
    const variants = await rewriter.rewrite(
      query,
      config,
      history?.length ? { history } : undefined
    )
    const cleaned = variants
      .map((item) => item.trim())
      .filter((item) => item && item !== query)
      .slice(0, MAX_QUERY_VARIANTS)
    return [query, ...cleaned]
  }

  /**
   * MMR 去冗余：token 取自 FTS 分词串（与 BM25 同一词表；缺失时用 SparseIndexer 现切兜底）。
   * 返回「选中项按 MMR 序在前、落选项保持原相对序在后」的重排数组（调用方随后截断）。
   */
  private applyMmr(hits: KnowledgeHit[], limit: number, lambda: number): KnowledgeHit[] {
    const tokenRows = this.deps.store.getChunkTokens(hits.map((hit) => hit.chunkId))
    const candidates: MmrCandidate[] = hits.map((hit) => ({
      chunkId: hit.chunkId,
      score: hit.score,
      tokens: tokensToSet(tokenRows.get(hit.chunkId) ?? this.deps.sparse.tokenize(hit.content))
    }))
    const order = selectMmr(candidates, limit, lambda)
    const chosen = new Map(order.map((chunkId, index) => [chunkId, index]))
    const selected = hits
      .filter((hit) => chosen.has(hit.chunkId))
      .sort((a, b) => (chosen.get(a.chunkId) ?? 0) - (chosen.get(b.chunkId) ?? 0))
    const rest = hits.filter((hit) => !chosen.has(hit.chunkId))
    return [...selected, ...rest]
  }

  /** 单条查询的三路召回与通道内融合（改写变体各自跑一遍） */
  private async collectVariant(input: {
    userId: string
    kbId: string
    query: string
    mode: KnowledgeSearchMode
    sparseAvailable: boolean
    denseAvailable: boolean
    candidateLimit: number
    config: KnowledgeEngineConfig
  }): Promise<{ candidates: FusedCandidate[]; seedNames: string[]; stats: VariantStats }> {
    const { config, candidateLimit } = input
    // 图扩展（第三路）：命中查询里的实体 → 一跳邻居 → 关联切片
    const wantGraph = input.mode === 'hybrid' && config.graphEnabled
    const graphStarted = performance.now()
    const graphExpansion = wantGraph
      ? this.deps.store.graphExpand({
          kbId: input.kbId,
          userId: input.userId,
          query: input.query,
          limit: candidateLimit
        })
      : { chunkIds: [], seedNames: [] }
    const graphMs = performance.now() - graphStarted

    let sparseMs = 0
    let denseMs = 0
    const [sparseHits, denseHits] = await Promise.all([
      input.sparseAvailable
        ? (() => {
            const started = performance.now()
            const hits = this.deps.sparse.search({
              kbId: input.kbId,
              userId: input.userId,
              query: input.query,
              limit: candidateLimit,
              k1: config.bm25K1,
              b: config.bm25B
            })
            sparseMs = performance.now() - started
            return Promise.resolve(hits)
          })()
        : Promise.resolve([]),
      input.denseAvailable
        ? (async () => {
            const started = performance.now()
            const hits = await this.denseSearch(
              input.userId,
              input.kbId,
              input.query,
              candidateLimit,
              config
            )
            denseMs = performance.now() - started
            return hits
          })()
        : Promise.resolve(null)
    ])

    // 稠密门限：最大余弦低于门槛视为「没有相关内容」（仅稠密路参与，稀疏命中仍然有效）
    const denseGateFailed =
      denseHits !== null &&
      config.minSimilarity > 0 &&
      (denseHits[0]?.score ?? 0) < config.minSimilarity
    const denseCandidates: Candidate[] = (denseGateFailed ? [] : (denseHits ?? []))
      .slice(0, candidateLimit)
      .map((hit, index) => ({ chunkId: hit.chunkId, score: hit.score, rank: index + 1 }))
    const sparseCandidates: Candidate[] = sparseHits
      .slice(0, candidateLimit)
      .map((hit, index) => ({ chunkId: hit.chunkId, score: hit.score, rank: index + 1 }))
    const graphCandidates: Candidate[] = graphExpansion.chunkIds
      .slice(0, candidateLimit)
      .map((chunkId, index) => ({ chunkId, score: 1 / (index + 1), rank: index + 1 }))

    return {
      candidates: fuse(sparseCandidates, denseCandidates, graphCandidates, config.hybridWeight),
      seedNames: graphExpansion.seedNames,
      stats: {
        channels: {
          sparse: sparseCandidates.length,
          dense: denseCandidates.length,
          graph: graphCandidates.length
        },
        ms: { sparse: sparseMs, dense: denseMs, graph: graphMs },
        gate:
          denseHits !== null && config.minSimilarity > 0
            ? {
                threshold: config.minSimilarity,
                topScore: denseHits[0]?.score ?? 0,
                failed: denseGateFailed
              }
            : null
      }
    }
  }

  private async denseSearch(
    userId: string,
    kbId: string,
    query: string,
    limit: number,
    config: KnowledgeEngineConfig
  ): Promise<Array<{ chunkId: number; score: number }>> {
    const embedder = this.deps.embedder
    if (!embedder) return []
    try {
      const [vector] = await embedder.embed([query], config)
      if (!vector) return []
      return this.deps.store.searchDense({
        kbId,
        userId,
        vector,
        dim: vector.length,
        limit
      })
    } catch (err) {
      console.warn('[knowledge-retrieval] 查询向量化失败，本次降级为稀疏检索：', err)
      return []
    }
  }
}

/** 图扩展通道的 RRF 权重（低于主结果：它是「关联召回」，不该压过直接命中） */
const GRAPH_CHANNEL_WEIGHT = 0.5

/** 查询改写最多采纳的变体数（不含原问题；与 web 的 DEFAULT_MAX_QUERIES 同量级） */
const MAX_QUERY_VARIANTS = 2

/** 融合后的候选（含来源与两路原始分） */
type FusedCandidate = {
  chunkId: number
  score: number
  vecScore?: number
  bm25Score?: number
  source: KnowledgeHit['source']
}

/** 单个改写变体的通道统计（调试面板用；无论 debug 开着与否都顺手记录） */
interface VariantStats {
  channels: { sparse: number; dense: number; graph: number }
  ms: { sparse: number; dense: number; graph: number }
  gate: { threshold: number; topScore: number; failed: boolean } | null
}

/** 空格分隔的分词串 → token 集合（MMR 相似度用） */
function tokensToSet(tokenText: string): Set<string> {
  const out = new Set<string>()
  for (const token of tokenText.split(/\s+/)) {
    if (token) out.add(token)
  }
  return out
}

/**
 * 跨变体融合：把每个改写变体的融合结果当一路候选，按**排名**做等权 RRF。
 * 用排名而非分数：各变体的分数尺度不同（稠密余弦/BM25/RRF 混在一起），RFF 只看位次天然免疫。
 */
export function fuseVariants(lists: FusedCandidate[][], candidateLimit: number): FusedCandidate[] {
  const merged = new Map<number, FusedCandidate & { contribution: number }>()
  for (const list of lists) {
    list.forEach((candidate, index) => {
      const rrf = 1 / (RRF_K + index + 1)
      const existing = merged.get(candidate.chunkId)
      if (!existing) {
        merged.set(candidate.chunkId, { ...candidate, score: rrf, contribution: rrf })
        return
      }
      existing.score += rrf
      if (candidate.vecScore !== undefined) existing.vecScore = candidate.vecScore
      if (candidate.bm25Score !== undefined) existing.bm25Score = candidate.bm25Score
      if (rrf > existing.contribution) {
        existing.contribution = rrf
        existing.source = candidate.source
      }
    })
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateLimit)
    .map((item) => ({
      chunkId: item.chunkId,
      score: item.score,
      vecScore: item.vecScore,
      bm25Score: item.bm25Score,
      source: item.source
    }))
}

/**
 * 融合：多通道加权 RRF；只有单路时直接用归一化分（不做伪 RRF，避免放大单路噪声）。
 * 通道权重：稠密 = hybridWeight，稀疏 = 1 - hybridWeight，图扩展 = 0.5。
 */
function fuse(
  sparse: Candidate[],
  dense: Candidate[],
  graph: Candidate[],
  denseWeight: number
): Array<{ chunkId: number; score: number; vecScore?: number; bm25Score?: number; source: KnowledgeHit['source'] }> {
  const w = Math.min(1, Math.max(0, denseWeight))
  type ChannelSource = NonNullable<KnowledgeHit['source']>
  const allChannels: Array<{ items: Candidate[]; weight: number; source: ChannelSource }> = [
    { items: dense, weight: w, source: 'dense' },
    { items: sparse, weight: 1 - w, source: 'sparse' },
    { items: graph, weight: GRAPH_CHANNEL_WEIGHT, source: 'graph' }
  ]
  const channels = allChannels.filter((channel) => channel.items.length > 0)

  if (channels.length <= 1) {
    const channel = channels[0]
    if (!channel) return []
    const max = channel.items[0]?.score || 1
    return channel.items.map((item) => ({
      chunkId: item.chunkId,
      score: item.score / max,
      vecScore: channel.source === 'dense' ? item.score : undefined,
      bm25Score: channel.source === 'sparse' ? item.score : undefined,
      source: channel.source
    }))
  }

  type Fused = {
    score: number
    vecScore?: number
    bm25Score?: number
    source: ChannelSource
    contribution: number
  }
  const scores = new Map<number, Fused>()
  for (const channel of channels) {
    for (const item of channel.items) {
      const rrf = channel.weight / (RRF_K + item.rank)
      const existing = scores.get(item.chunkId)
      if (!existing) {
        scores.set(item.chunkId, {
          score: rrf,
          vecScore: channel.source === 'dense' ? item.score : undefined,
          bm25Score: channel.source === 'sparse' ? item.score : undefined,
          source: channel.source,
          contribution: rrf
        })
        continue
      }
      existing.score += rrf
      if (channel.source === 'dense') existing.vecScore = item.score
      if (channel.source === 'sparse') existing.bm25Score = item.score
      // 来源标记给「贡献最大」的那一路
      if (rrf > existing.contribution) {
        existing.contribution = rrf
        existing.source = channel.source
      }
    }
  }
  return [...scores.entries()]
    .map(([chunkId, value]) => ({
      chunkId,
      score: value.score,
      vecScore: value.vecScore,
      bm25Score: value.bm25Score,
      source: value.source
    }))
    .sort((a, b) => b.score - a.score)
}

/** 同一文档相邻切片（序号差 ≤1）合并为一条，content 拼接、分数取最高 */
function mergeAdjacent(hits: KnowledgeHit[]): KnowledgeHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const merged: KnowledgeHit[] = []
  const consumed = new Set<number>()
  for (const hit of sorted) {
    if (consumed.has(hit.chunkId)) continue
    const group = sorted.filter(
      (other) =>
        !consumed.has(other.chunkId) &&
        other.docId === hit.docId &&
        Math.abs(other.chunkIndex - hit.chunkIndex) <= 1
    )
    group.sort((a, b) => a.chunkIndex - b.chunkIndex)
    for (const item of group) consumed.add(item.chunkId)
    const content = group.map((item) => item.content).join('\n')
    merged.push({
      ...hit,
      content,
      score: Math.max(...group.map((item) => item.score)),
      charStart: group[0].charStart,
      charEnd: group[group.length - 1].charEnd
    })
  }
  return merged
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) return 12
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 空查询短路的调试载荷（面板保持字段形状一致，全部为空） */
function emptyDebugInfo(mode: KnowledgeSearchMode, topK: number): RetrievalDebugInfo {
  const zero = { candidates: 0, ms: 0 }
  return {
    mode,
    topK,
    candidateLimit: 0,
    variants: [],
    timings: [{ stage: 'total', ms: 0 }],
    channels: { sparse: { ...zero }, dense: { ...zero }, graph: { ...zero } },
    denseGate: null,
    flags: {
      vectorSkipped: mode === 'bm25',
      sparseSkipped: mode === 'vector',
      rerankSkipped: true,
      mmrApplied: false,
      decayApplied: false
    },
    fusedCount: 0,
    hits: []
  }
}
