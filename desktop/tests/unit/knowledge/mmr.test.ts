import { describe, expect, it } from 'vitest'
import { jaccardSimilarity, selectMmr, type MmrCandidate } from '../../../src/main/knowledge/mmr'

/** 候选构造：tokens 用空格分隔的串写，便于目测 */
function candidate(chunkId: number, score: number, tokens: string): MmrCandidate {
  return { chunkId, score, tokens: new Set(tokens.split(' ').filter(Boolean)) }
}

describe('jaccardSimilarity', () => {
  it('完全相同 = 1，不相交 = 0', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('部分重合按 |A∩B| / |A∪B|', () => {
    // 交集 {b} = 1，并集 {a,b,c} = 3
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
  })

  it('任一为空集返回 0（不崩、不误判）', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0)
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0)
  })
})

describe('selectMmr', () => {
  it('λ=1 退化为按相关度排序；同分保持原序', () => {
    const candidates = [candidate(1, 0.5, 'a'), candidate(2, 0.9, 'b'), candidate(3, 0.5, 'c')]
    // 1 与 3 同分（rel 相同）→ 原序靠前的 1 先入选
    expect(selectMmr(candidates, 2, 1)).toEqual([2, 1])
  })

  it('limit ≥ 候选数时原序返回（不做无意义重排）', () => {
    const candidates = [candidate(1, 0.5, 'a'), candidate(2, 0.9, 'b')]
    expect(selectMmr(candidates, 5, 0.7)).toEqual([1, 2])
  })

  it('近重复候选被换出：top1 与 top2 高度重合时，第二位让给不重合的候选', () => {
    // 1 号与 2 号 tokens 完全一致（Jaccard=1），3 号完全不同
    const candidates = [
      candidate(1, 1.0, '冷启动 优化 缓存 预热'),
      candidate(2, 0.95, '冷启动 优化 缓存 预热'),
      candidate(3, 0.6, '数据库 索引 重建')
    ]
    // λ=0.5 时：2 号 rel≈0.95 但冗余 1；3 号 rel≈0.5 冗余 0 → 3 号胜出
    expect(selectMmr(candidates, 2, 0.5)).toEqual([1, 3])
    // λ=1（纯相关度）时仍选 2 号
    expect(selectMmr(candidates, 2, 1)).toEqual([1, 2])
  })

  it('λ=0 纯多样性：第二个选与第一个最不相似的', () => {
    const candidates = [
      candidate(1, 1.0, 'a b'),
      candidate(2, 0.9, 'a b c'), // 与 1 相似度 2/3
      candidate(3, 0.1, 'x y') // 与 1 相似度 0
    ]
    expect(selectMmr(candidates, 2, 0)).toEqual([1, 3])
  })

  it('确定性：同输入两次结果一致；空 token 集合不崩', () => {
    const candidates = [
      candidate(1, 0.8, ''),
      candidate(2, 0.7, 'a b'),
      candidate(3, 0.6, 'a b c')
    ]
    const first = selectMmr(candidates, 2, 0.7)
    const second = selectMmr(candidates, 2, 0.7)
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
  })

  it('负数分数（理论边界）仍稳定：min-max 归一后按相对大小选', () => {
    const candidates = [
      candidate(1, -0.1, 'a'),
      candidate(2, -0.5, 'b'),
      candidate(3, -0.3, 'c')
    ]
    expect(selectMmr(candidates, 1, 1)).toEqual([1])
  })
})
