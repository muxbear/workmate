import { describe, expect, it } from 'vitest'
import { applyTimeDecay, decayFactor } from '../../../src/main/knowledge/time-decay'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

describe('decayFactor', () => {
  it('半衰期关闭（0/负值）恒为 1', () => {
    expect(decayFactor(NOW - 365 * DAY, NOW, 0)).toBe(1)
    expect(decayFactor(NOW - 365 * DAY, NOW, -1)).toBe(1)
  })

  it('恰好一个半衰期 → 0.5；两个半衰期 → 0.25', () => {
    expect(decayFactor(NOW - 30 * DAY, NOW, 30)).toBeCloseTo(0.5)
    expect(decayFactor(NOW - 60 * DAY, NOW, 30)).toBeCloseTo(0.25)
  })

  it('缺失时间按 0 年龄处理（不衰减）；未来时间 clamp 到 1（不放大）', () => {
    expect(decayFactor(undefined, NOW, 30)).toBe(1)
    expect(decayFactor(NOW + 10 * DAY, NOW, 30)).toBe(1)
  })
})

describe('applyTimeDecay', () => {
  it('半衰期 0：原样返回（同一引用，零开销）', () => {
    const hits = [{ score: 1, uploadedAt: NOW - 365 * DAY }]
    expect(applyTimeDecay(hits, NOW, 0)).toBe(hits)
  })

  it('同等相关度下新文档排前：半衰期 30 天，老文档（60 天）分数打 0.25', () => {
    const hits = [
      { score: 1, uploadedAt: NOW - 60 * DAY },
      { score: 0.5, uploadedAt: NOW }
    ]
    const sorted = applyTimeDecay(hits, NOW, 30)
    expect(sorted[0].score).toBeCloseTo(0.5) // 新文档原分
    expect(sorted[1].score).toBeCloseTo(0.25) // 老文档 1 × 0.25
    expect(sorted[0].score).toBeGreaterThan(sorted[1].score)
  })

  it('衰减系数小到足以让老的高分文档让位', () => {
    const hits = [
      { score: 1, uploadedAt: NOW - 300 * DAY },
      { score: 0.6, uploadedAt: NOW }
    ]
    const sorted = applyTimeDecay(hits, NOW, 30) // 老文档 1 × 0.5^10 ≈ 0.001
    expect(sorted[0].score).toBeCloseTo(0.6)
  })

  it('缺失 uploadedAt 的项不衰减；返回新数组不改原对象', () => {
    const hits = [{ score: 1 }, { score: 0.9, uploadedAt: NOW - 30 * DAY }]
    const sorted = applyTimeDecay(hits, NOW, 30)
    expect(sorted[0].score).toBe(1)
    expect(sorted[1].score).toBeCloseTo(0.45)
    expect(hits[0].score).toBe(1) // 原数组未被改动
  })
})
