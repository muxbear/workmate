import { describe, expect, it } from 'vitest'
import {
  buildSpaceDeleteMessage,
  countTasksBySpace,
  moveSpace,
  resolveConversationSpaceId,
  type SpaceConversationRef
} from '../../../src/renderer/src/components/space/spaceList'
import type { Workspace } from '../../../src/shared/contracts'

/** 空间桩（只填归属/排序用得到的字段） */
function space(id: string, source: Workspace['source'] = 'created'): Workspace {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    source,
    userId: source === 'default' ? null : 'u1',
    createdAt: 1,
    sortOrder: 0
  }
}

/** 会话桩：workspace 为 null 表示无绑定（归属默认空间） */
function conversation(workspaceId: string | null): SpaceConversationRef {
  return { workspace: workspaceId ? { id: workspaceId, name: workspaceId } : null }
}

describe('spaceList.moveSpace', () => {
  const items = [space('a'), space('b'), space('c')]

  it('把元素移动到目标下标（原数组不变）', () => {
    const next = moveSpace(items, 0, 2)
    expect(next.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(items.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('向后移动时目标下标按"摘除后"语义（与拖拽落点换算一致）', () => {
    expect(moveSpace(items, 2, 0).map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(moveSpace(items, 1, 1).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('原地不动返回原数组（调用方可据此跳过上报）', () => {
    expect(moveSpace(items, 1, 1)).toBe(items)
  })

  it('起点非法或越界目标夹取', () => {
    expect(moveSpace(items, -1, 1)).toBe(items)
    expect(moveSpace(items, 9, 1)).toBe(items)
    expect(moveSpace(items, 0, 99).map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(moveSpace(items, 2, -5).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('spaceList.resolveConversationSpaceId', () => {
  const spaceIds = new Set(['s1', 's2', 'default'])

  it('绑定空间仍在列表中 → 该空间', () => {
    expect(resolveConversationSpaceId(conversation('s2'), spaceIds, 'default')).toBe('s2')
  })

  it('无绑定 → 默认空间', () => {
    expect(resolveConversationSpaceId(conversation(null), spaceIds, 'default')).toBe('default')
  })

  it('绑定空间已被删除（不在列表）→ 默认空间', () => {
    expect(resolveConversationSpaceId(conversation('gone'), spaceIds, 'default')).toBe('default')
  })

  it('无默认空间记录 → null（数据异常，调用方按不展示处理）', () => {
    expect(resolveConversationSpaceId(conversation('gone'), spaceIds, null)).toBeNull()
    // 绑定有效时不受默认空间缺失影响
    expect(resolveConversationSpaceId(conversation('s1'), spaceIds, null)).toBe('s1')
  })
})

describe('spaceList.countTasksBySpace', () => {
  it('按归属分组计数（含默认空间兜底），空空间不出现在结果里', () => {
    const counts = countTasksBySpace(
      [conversation('s1'), conversation('s1'), conversation(null), conversation('gone')],
      new Set(['s1', 's2', 'default']),
      'default'
    )
    expect(counts.get('s1')).toBe(2)
    expect(counts.get('default')).toBe(2)
    expect(counts.has('s2')).toBe(false)
  })

  it('无默认空间时只统计有效绑定的会话', () => {
    const counts = countTasksBySpace([conversation('s1'), conversation(null)], new Set(['s1']), null)
    expect(counts.get('s1')).toBe(1)
    expect(counts.size).toBe(1)
  })
})

describe('spaceList.buildSpaceDeleteMessage', () => {
  it('文案含任务数与不可恢复提示（侧栏与管理页共用）', () => {
    const message = buildSpaceDeleteMessage(2)
    expect(message).toContain('2 个任务')
    expect(message).toContain('无法恢复')
    expect(message).toContain('确认移除？')
  })

  it('零任务也走同一串文案', () => {
    expect(buildSpaceDeleteMessage(0)).toContain('0 个任务')
  })
})
