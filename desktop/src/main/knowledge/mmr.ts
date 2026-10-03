/**
 * MMR（Maximal Marginal Relevance）去冗余：纯函数实现（P7 增强层，默认关闭）。
 *
 * 与经典 MMR 的工程差异：相似度用 **token 集合 Jaccard**（分词串来自 FTS 索引，
 * 与 BM25 同一词表）而非 embedding 余弦 —— 桌面端纯稀疏 / 信创离线部署时库里可能
 * 根本没有向量，token 口径在全部检索模式下都可用，且完全确定性（便于回归钉住）。
 *
 * 公式：mmr = λ · rel − (1−λ) · maxSim(候选, 已选项)；rel 为候选分数的 min-max 归一。
 */

export interface MmrCandidate {
  chunkId: number
  score: number
  /** 候选内容的分词集合；空集合视为「无相似度信息」（sim 记 0） */
  tokens: Set<string>
}

/** 集合 Jaccard 相似度（|A∩B| / |A∪B|；任一为空集返回 0） */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const token of small) {
    if (large.has(token)) intersection += 1
  }
  if (intersection === 0) return 0
  return intersection / (a.size + b.size - intersection)
}

/**
 * 贪心 MMR：返回选中 chunkId 的顺序（长度 = min(limit, 候选数)）。
 * - rel 用 min-max 归一（免疫 rerank 与 RRF 两种分数尺度）；
 * - 同分保留更靠前的候选（对入参顺序稳定 → 确定性可测）。
 */
export function selectMmr(candidates: MmrCandidate[], limit: number, lambda: number): number[] {
  const total = candidates.length
  if (limit >= total || total === 0) return candidates.map((item) => item.chunkId)
  const l = Math.min(1, Math.max(0, lambda))
  const scores = candidates.map((item) => item.score)
  const maxScore = Math.max(...scores)
  const minScore = Math.min(...scores)
  const span = maxScore - minScore
  const relevance = (score: number): number => (span > 0 ? (score - minScore) / span : 1)

  const remaining = candidates.map((_, index) => index)
  /** maxSim[i]：候选 i 与「已选项」的最大 Jaccard（每选中一个就增量更新） */
  const maxSim = new Array<number>(total).fill(0)
  const selected: number[] = []
  while (selected.length < limit && remaining.length) {
    let bestPos = 0
    let bestValue = -Infinity
    for (let pos = 0; pos < remaining.length; pos += 1) {
      const index = remaining[pos]
      const value = l * relevance(candidates[index].score) - (1 - l) * maxSim[index]
      if (value > bestValue) {
        bestValue = value
        bestPos = pos
      }
    }
    const chosen = remaining.splice(bestPos, 1)[0]
    selected.push(candidates[chosen].chunkId)
    for (const index of remaining) {
      const sim = jaccardSimilarity(candidates[index].tokens, candidates[chosen].tokens)
      if (sim > maxSim[index]) maxSim[index] = sim
    }
  }
  return selected
}
