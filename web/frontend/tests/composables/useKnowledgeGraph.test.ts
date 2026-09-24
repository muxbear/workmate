import { describe, expect, it } from 'vitest'
import { useKnowledgeGraph } from '@/composables/useKnowledgeGraph'
import type { Entity, Relation } from '@/types/knowledgeBase'

function entity(id: string, name = id): Entity {
  return { id, name, type: '概念', mentions: 1, x: 0, y: 0 }
}

function relation(id: string, from: string, to: string): Relation {
  return { id, from, to, label: '关联', weight: 1 }
}

describe('useKnowledgeGraph · selectEntity', () => {
  it('点击实体后进入选中态', () => {
    const graph = useKnowledgeGraph()

    graph.selectEntity('e1')

    expect(graph.selectedEntityId.value).toBe('e1')
  })

  it('再次点击同一实体时取消选中', () => {
    const graph = useKnowledgeGraph()

    graph.selectEntity('e1')
    graph.selectEntity('e1')

    expect(graph.selectedEntityId.value).toBeNull()
  })

  it('点击另一个实体时切换选中', () => {
    const graph = useKnowledgeGraph()

    graph.selectEntity('e1')
    graph.selectEntity('e2')

    expect(graph.selectedEntityId.value).toBe('e2')
  })

  it('选中后关联实体的高亮集合包含自身与邻居', () => {
    const graph = useKnowledgeGraph()
    graph.init(
      [entity('e1'), entity('e2'), entity('e3')],
      [relation('r1', 'e1', 'e2')],
    )

    graph.selectEntity('e1')

    expect(graph.connectedNodeIds.value).toEqual(new Set(['e1', 'e2']))
    expect(graph.connectedNodeIds.value.has('e3')).toBe(false)
  })

  it('取消选中后高亮集合清空', () => {
    const graph = useKnowledgeGraph()
    graph.init([entity('e1'), entity('e2')], [relation('r1', 'e1', 'e2')])

    graph.selectEntity('e1')
    graph.selectEntity('e1')

    expect(graph.connectedNodeIds.value.size).toBe(0)
  })
})
