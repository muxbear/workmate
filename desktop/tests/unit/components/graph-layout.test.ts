import { describe, expect, it } from 'vitest'
import { layoutGraph, type GraphLayoutInput } from '../../../src/renderer/src/components/knowledge/graphLayout'

/**
 * 图谱力导向布局（纯函数，零依赖）。
 * 布局必须完全确定性：同一输入两次结果一致、输入顺序不影响结果（内部按 key 排序）。
 */

const WIDTH = 400
const HEIGHT = 300
const OPTIONS = { width: WIDTH, height: HEIGHT, iterations: 160 }

function distance(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('layoutGraph', () => {
  it('空输入返回空 positions；单节点落在画布中心', () => {
    const empty = layoutGraph({ nodes: [], links: [] }, OPTIONS)
    expect(empty.positions.size).toBe(0)

    const single = layoutGraph({ nodes: [{ key: 'a', mentions: 1 }], links: [] }, OPTIONS)
    expect(single.positions.get('a')).toEqual({ x: WIDTH / 2, y: HEIGHT / 2 })
  })

  it('确定性：同输入两次一致；输入顺序（节点与边反转）不影响结果', () => {
    const nodes = [
      { key: 'a', mentions: 1 },
      { key: 'b', mentions: 2 },
      { key: 'c', mentions: 1 },
      { key: 'd', mentions: 3 }
    ]
    const links = [
      { from: 'a', to: 'b', weight: 1 },
      { from: 'c', to: 'b', weight: 1 },
      { from: 'd', to: 'a', weight: 1 }
    ]
    const one = layoutGraph({ nodes, links }, OPTIONS)
    const two = layoutGraph({ nodes, links }, OPTIONS)
    const shuffled = layoutGraph(
      { nodes: [...nodes].reverse(), links: [...links].reverse() },
      OPTIONS
    )
    for (const node of nodes) {
      expect(two.positions.get(node.key)).toEqual(one.positions.get(node.key))
      expect(shuffled.positions.get(node.key)?.x).toBeCloseTo(one.positions.get(node.key)!.x, 6)
      expect(shuffled.positions.get(node.key)?.y).toBeCloseTo(one.positions.get(node.key)!.y, 6)
    }
  })

  it('坐标有限且落在画布范围内（含孤立节点）', () => {
    const input: GraphLayoutInput = {
      nodes: [
        { key: 'a', mentions: 1 },
        { key: 'b', mentions: 5 },
        { key: 'c', mentions: 1 },
        { key: 'isolated', mentions: 1 }
      ],
      links: [{ from: 'a', to: 'b', weight: 1 }]
    }
    const result = layoutGraph(input, OPTIONS)
    for (const node of input.nodes) {
      const point = result.positions.get(node.key)!
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(WIDTH)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(HEIGHT)
    }
  })

  it('有边相连的节点比无关联的节点更近', () => {
    const input: GraphLayoutInput = {
      nodes: [
        { key: 'a', mentions: 1 },
        { key: 'b', mentions: 1 },
        { key: 'c', mentions: 1 },
        { key: 'lonely', mentions: 1 }
      ],
      links: [
        { from: 'a', to: 'b', weight: 1 },
        { from: 'b', to: 'c', weight: 1 }
      ]
    }
    const { positions } = layoutGraph(input, OPTIONS)
    const ab = distance(positions.get('a'), positions.get('b'))
    const bc = distance(positions.get('b'), positions.get('c'))
    const aLonely = distance(positions.get('a'), positions.get('lonely'))
    expect(ab).toBeLessThan(aLonely)
    expect(bc).toBeLessThan(aLonely)
  })

  it('重复节点重合时（同 key 不存在，防 0 除）不产生 NaN', () => {
    // 两个不同 key 但布局上可能被推得很近；用同坐标起点验证数值稳定
    const input: GraphLayoutInput = {
      nodes: [
        { key: 'x', mentions: 1 },
        { key: 'y', mentions: 1 }
      ],
      links: []
    }
    const { positions } = layoutGraph(input, { width: 1, height: 1, iterations: 50 })
    for (const key of ['x', 'y']) {
      const point = positions.get(key)!
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })
})
