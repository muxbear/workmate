import type { KnowledgeStore } from './KnowledgeStore'
import type { KnowledgeSettingsService } from './KnowledgeSettingsService'
import type { SparseIndexer } from './SparseIndexer'
import type { KnowledgeEmbedder } from './KnowledgeIndexService'
import { toEngineConfig, type KnowledgeEngineConfig } from './knowledge-config'
import type { KnowledgeHit, KnowledgeSearchMode, KnowledgeSearchResult } from './types'

/**
 * 检索服务：页面问答（2-Step RAG）、会话 kb_search 工具（Agentic RAG）共用同一条链路。
 *
 * 管线（顺序不可交换）：
 *   召回（FTS5 BM25 ‖ vec0 KNN）→ 加权 RRF 融合 → 相邻块合并去重 → 重排（可选）→ topK 截断
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
}

/** 召回阶段的一条候选（融合前） */
interface Candidate {
  chunkId: number
  score: number
  rank: number
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
  }): Promise<KnowledgeSearchResult> {
    const query = String(input.query ?? '').trim()
    const config = this.effectiveConfig(input.userId, input.kbId)
    const mode: KnowledgeSearchMode = input.mode ?? 'hybrid'
    const topK = clampTopK(input.topK ?? config.topK)
    if (!query) {
      return {
        hits: [],
        vectorSkipped: mode === 'bm25',
        sparseSkipped: mode === 'vector',
        rerankSkipped: !config.rerankEnabled,
        noRelevantResult: true
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

    const candidateLimit =
      topK *
      (config.rerankEnabled
        ? CANDIDATE_MULTIPLIER_RERANK
        : CANDIDATE_MULTIPLIER_PLAIN)

    // 图扩展（第三路，P3）：命中查询里的实体 → 一跳邻居 → 关联切片
    const wantGraph = mode === 'hybrid' && config.graphEnabled
    const graphExpansion = wantGraph
      ? this.deps.store.graphExpand({
          kbId: input.kbId,
          userId: input.userId,
          query,
          limit: candidateLimit
        })
      : { chunkIds: [], seedNames: [] }

    const [sparseHits, denseHits] = await Promise.all([
      sparseAvailable
        ? Promise.resolve(
            this.deps.sparse.search({
              kbId: input.kbId,
              userId: input.userId,
              query,
              limit: candidateLimit,
              k1: config.bm25K1,
              b: config.bm25B
            })
          )
        : Promise.resolve([]),
      denseAvailable ? this.denseSearch(input.userId, input.kbId, query, candidateLimit, config) : Promise.resolve(null)
    ])

    // 稠密门限：最大余弦低于门槛视为「没有相关内容」（仅稠密路参与，稀疏命中仍然有效）
    const denseGateFailed =
      denseHits !== null && config.minSimilarity > 0 && (denseHits[0]?.score ?? 0) < config.minSimilarity
    const denseCandidates: Candidate[] = (denseGateFailed ? [] : (denseHits ?? []))
      .slice(0, candidateLimit)
      .map((hit, index) => ({ chunkId: hit.chunkId, score: hit.score, rank: index + 1 }))
    const sparseCandidates: Candidate[] = sparseHits
      .slice(0, candidateLimit)
      .map((hit, index) => ({ chunkId: hit.chunkId, score: hit.score, rank: index + 1 }))

    const graphCandidates: Candidate[] = graphExpansion.chunkIds
      .slice(0, candidateLimit)
      .map((chunkId, index) => ({ chunkId, score: 1 / (index + 1), rank: index + 1 }))

    const fused = fuse(
      sparseCandidates,
      denseCandidates,
      graphCandidates,
      config.hybridWeight
    )
    if (!fused.length) {
      // 召回到此为止就是空：如实标记「没有相关内容」，问答据此不编造
      return {
        hits: [],
        vectorSkipped: !denseAvailable,
        sparseSkipped: !sparseAvailable,
        rerankSkipped: !config.rerankEnabled || !this.deps.reranker?.available(config),
        noRelevantResult: true
      }
    }

    // 取内容（JOIN 文档表；渲染层只拿 relPath/docName）
    const details = this.deps.store.getChunksByIds(fused.map((item) => item.chunkId))
    const detailMap = new Map(details.map((detail) => [detail.chunkId, detail]))
    let hits: KnowledgeHit[] = []
    for (const item of fused) {
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
        charEnd: detail.charEnd
      })
    }

    hits = mergeAdjacent(hits)

    // 重排（可选）：失败/不可用只降级，保留融合顺序
    let rerankSkipped = !config.rerankEnabled
    if (config.rerankEnabled && this.deps.reranker?.available(config)) {
      const result = await this.deps.reranker
        .rerank(
          query,
          hits.slice(0, topK * CANDIDATE_MULTIPLIER_RERANK).map((hit) => hit.content),
          config
        )
        .catch(() => null)
      if (result) {
        const head = hits.slice(0, result.length)
        head.forEach((hit, index) => {
          hit.score = result[index]
        })
        head.sort((a, b) => b.score - a.score)
        hits = [...head, ...hits.slice(result.length)]
      } else {
        rerankSkipped = true
      }
    } else if (config.rerankEnabled) {
      rerankSkipped = true
    }

    const finalHits = hits.slice(0, topK)
    return {
      hits: finalHits,
      vectorSkipped: !denseAvailable,
      sparseSkipped: !sparseAvailable,
      rerankSkipped,
      noRelevantResult: finalHits.length === 0,
      ...(graphExpansion.seedNames.length
        ? { graphEntities: graphExpansion.seedNames }
        : {})
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
