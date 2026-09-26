import { describe, expect, it } from 'vitest'
import {
  ENTITY_TYPE_COLORS,
  ENTITY_TYPE_FALLBACK_COLOR,
} from '@/types/knowledgeBase'

/**
 * 实体类型配色表（迭代 6 T6.5）。
 *
 * 此前这份表在三个组件里**各写一份且只有 5 类**，而后端提示词是 12 类——于是 7 类实体
 * 全渲染成灰色。这里锁住"配色覆盖受控词表的 8 类"，并防止再次分叉。
 */
describe('实体类型配色', () => {
  // 与 web/backend/src/api/knowledge_base/entity_norm.py 的 ENTITY_TYPES 同口径
  const CONTROLLED_VOCABULARY = [
    '人物', '组织', '产品', '概念', '算法', '地点', '时间', '事件',
  ]

  it('覆盖受控词表的每一类', () => {
    const missing = CONTROLLED_VOCABULARY.filter((t) => !ENTITY_TYPE_COLORS[t])
    expect(missing, `这些类型没有配色，会渲染成灰色: ${missing}`).toEqual([])
  })

  it('没有多余的、词表外的键', () => {
    const extra = Object.keys(ENTITY_TYPE_COLORS).filter(
      (t) => !CONTROLLED_VOCABULARY.includes(t),
    )
    expect(extra).toEqual([])
  })

  it('颜色互不相同', () => {
    const colors = Object.values(ENTITY_TYPE_COLORS)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('兜底色不与任何类型撞色', () => {
    // 撞色会让"越界类型"看起来像一个正常类型，排查时误导人
    expect(Object.values(ENTITY_TYPE_COLORS)).not.toContain(
      ENTITY_TYPE_FALLBACK_COLOR,
    )
  })
})
