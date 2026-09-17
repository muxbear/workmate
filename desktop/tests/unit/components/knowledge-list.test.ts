import { describe, expect, it } from 'vitest'
import {
  allLibraries,
  clampDropIndex,
  findGroupIdOf,
  moveLibrary,
  pickSelectionAfterRemoval,
  removeLibrary,
  renameLibrary,
  type KnowledgeFolder,
  type KnowledgeGroup
} from '../../../src/renderer/src/components/knowledge/knowledgeList'

/** 两个分组、三个知识库的固定样本（每次返回新对象，便于断言不可变性） */
function createGroups(): KnowledgeGroup[] {
  return [
    {
      id: 'local',
      label: '本地知识库',
      icon: 'hard-drive',
      items: [
        {
          id: 'product',
          name: '产品资料库',
          description: '产品规划',
          files: 28,
          updated: '今天',
          tone: '#168b7a'
        },
        {
          id: 'design',
          name: '设计规范',
          description: '界面规范',
          files: 16,
          updated: '昨天',
          tone: '#3b82f6'
        }
      ]
    },
    {
      id: 'shared',
      label: '我的共享知识',
      icon: 'users',
      items: [
        {
          id: 'team',
          name: '团队共享',
          description: '协作资料',
          files: 9,
          updated: '9 月 2 日',
          tone: '#64748b'
        }
      ]
    }
  ]
}

describe('knowledgeList 列表变换', () => {
  it('allLibraries 扁平化所有分组', () => {
    expect(allLibraries(createGroups()).map((item) => item.id)).toEqual([
      'product',
      'design',
      'team'
    ])
  })

  it('findGroupIdOf 定位所属分组，未找到返回 null', () => {
    const groups = createGroups()
    expect(findGroupIdOf(groups, 'design')).toBe('local')
    expect(findGroupIdOf(groups, 'team')).toBe('shared')
    expect(findGroupIdOf(groups, 'missing')).toBeNull()
  })

  it('renameLibrary 不可变替换目标条目并刷新 updated', () => {
    const before = createGroups()
    const after = renameLibrary(before, 'design', { name: '新名字', description: '新描述' })

    // 原数组未被修改
    expect(before[0].items[1].name).toBe('设计规范')
    // 目标条目已更新
    expect(after[0].items[1]).toMatchObject({
      id: 'design',
      name: '新名字',
      description: '新描述',
      files: 16,
      tone: '#3b82f6',
      updated: '刚刚'
    })
    // 其它条目引用保持不变
    expect(after[0].items[0]).toBe(before[0].items[0])
    expect(after[1]).toBe(before[1])
  })

  it('renameLibrary 找不到目标时结构不变', () => {
    const before = createGroups()
    const after = renameLibrary(before, 'missing', { name: 'x', description: 'y' })
    expect(allLibraries(after).map((item) => item.name)).toEqual(
      allLibraries(before).map((item) => item.name)
    )
  })

  it('removeLibrary 只删目标条目，分组保留可为空', () => {
    const before = createGroups()
    const after = removeLibrary(before, 'team')
    expect(before[1].items).toHaveLength(1) // 原数组未被修改
    expect(after[1].items).toHaveLength(0)
    expect(after[1].label).toBe('我的共享知识')
    expect(allLibraries(after).map((item) => item.id)).toEqual(['product', 'design'])
  })

  it('moveLibrary 把条目移动到目标下标，返回新数组', () => {
    const items = allLibraries(createGroups())
    const moved = moveLibrary(items, 0, 2)
    expect(moved.map((item) => item.id)).toEqual(['design', 'team', 'product'])
    // 原数组保持不变
    expect(items.map((item) => item.id)).toEqual(['product', 'design', 'team'])
  })

  it('moveLibrary 原地移动或起点越界时原样返回，目标越界夹取到末尾', () => {
    const items = allLibraries(createGroups())
    expect(moveLibrary(items, 0, 0)).toBe(items)
    expect(moveLibrary(items, 9, 1)).toBe(items)
    expect(moveLibrary(items, 0, 99).map((item) => item.id)).toEqual(['design', 'team', 'product'])
  })

  it('clampDropIndex 未置顶项拖不进置顶区，置顶项拖不出置顶区', () => {
    const items: KnowledgeFolder[] = [
      { id: 'a', name: 'A', description: '', files: 0, updated: '', tone: '#000', pinned: true },
      { id: 'b', name: 'B', description: '', files: 0, updated: '', tone: '#000', pinned: true },
      { id: 'c', name: 'C', description: '', files: 0, updated: '', tone: '#000' },
      { id: 'd', name: 'D', description: '', files: 0, updated: '', tone: '#000' }
    ]
    // 未置顶项（from=2）落点被抬到未置顶区首位
    expect(clampDropIndex(items, 2, 0)).toBe(2)
    // 置顶项（from=0）落点被压回置顶区末位
    expect(clampDropIndex(items, 0, 3)).toBe(1)
    // 区内移动保持原下标
    expect(clampDropIndex(items, 3, 2)).toBe(2)
  })

  it('pickSelectionAfterRemoval 优先同分组首项', () => {
    const groups = removeLibrary(createGroups(), 'product')
    expect(pickSelectionAfterRemoval(groups, 'local')?.id).toBe('design')
  })

  it('pickSelectionAfterRemoval 原分组已空时回落到全局首项', () => {
    const groups = removeLibrary(createGroups(), 'team')
    expect(pickSelectionAfterRemoval(groups, 'shared')?.id).toBe('product')
  })

  it('pickSelectionAfterRemoval 全部为空返回 null', () => {
    expect(pickSelectionAfterRemoval([], null)).toBeNull()
    const empty: KnowledgeGroup[] = [{ id: 'local', label: '本地', icon: 'hard-drive', items: [] }]
    expect(pickSelectionAfterRemoval(empty, 'local')).toBeNull()
  })
})
