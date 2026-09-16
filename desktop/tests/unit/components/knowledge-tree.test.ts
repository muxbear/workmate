import { describe, expect, it } from 'vitest'
import {
  childKey,
  collectFileNodes,
  findNode,
  flattenVisible,
  mergeUploads,
  parentKeyOf,
  patchFile,
  remapKey,
  removeNode,
  renameNode,
  sortTree,
  type KnowledgeFileMeta,
  type KnowledgeNode
} from '../../../src/renderer/src/components/knowledge/knowledgeTree'

/** 文件元信息样本 */
function meta(name: string, patch: Partial<KnowledgeFileMeta> = {}): KnowledgeFileMeta {
  return {
    name,
    type: 'PDF',
    size: '1 MB',
    updated: '今天 10:00',
    icon: 'file-text',
    tint: '#ef4444',
    ...patch
  }
}

/** 一棵两层样本树：根级文件 + 文件夹「设计规范」+ 子文件夹「组件」 */
function sampleTree(): KnowledgeNode[] {
  return mergeUploads(
    [],
    [
      { dirs: [], file: meta('路线图.pdf') },
      { dirs: ['设计规范'], file: meta('规范.md') },
      { dirs: ['设计规范', '组件'], file: meta('按钮.md') }
    ]
  )
}

describe('knowledgeTree 文件树变换', () => {
  it('childKey / parentKeyOf 互为逆运算（根级为空字符串）', () => {
    expect(childKey('', 'a')).toBe('a')
    expect(childKey('a', 'b')).toBe('a/b')
    expect(parentKeyOf('a/b/c')).toBe('a/b')
    expect(parentKeyOf('a')).toBe('')
  })

  it('mergeUploads 按目录层级建树：文件夹按需创建、根级文件并存', () => {
    const tree = sampleTree()
    expect(tree.map((node) => node.kind)).toEqual(['file', 'folder'])

    const folder = tree[1]
    expect(folder.key).toBe('设计规范')
    // 文件夹本身被「规范.md」占用时，子目录键不受影响
    expect(folder.children?.map((node) => node.key)).toEqual(['设计规范/规范.md', '设计规范/组件'])

    const nested = findNode(tree, '设计规范/组件/按钮.md')
    expect(nested?.file?.name).toBe('按钮.md')
    expect(collectFileNodes(tree).map((node) => node.key)).toEqual([
      '路线图.pdf',
      '设计规范/规范.md',
      '设计规范/组件/按钮.md'
    ])
  })

  it('mergeUploads 同名文件覆盖且不改动无关节点', () => {
    const before = sampleTree()
    const after = mergeUploads(before, [{ dirs: [], file: meta('路线图.pdf', { size: '2 MB' }) }])
    expect(findNode(after, '路线图.pdf')?.file?.size).toBe('2 MB')
    // 未受影响的文件夹保持原引用
    expect(after[1]).toBe(before[1])
  })

  it('renameNode 重命名文件：key 与元信息同步更新', () => {
    const after = renameNode(sampleTree(), '设计规范/规范.md', '规范 V2.md')
    expect(findNode(after, '设计规范/规范.md')).toBeNull()
    expect(findNode(after, '设计规范/规范 V2.md')?.file?.name).toBe('规范 V2.md')
  })

  it('renameNode 重命名文件夹：子孙节点 key 一起改写', () => {
    const after = renameNode(sampleTree(), '设计规范', '规范中心')
    expect(findNode(after, '规范中心/组件/按钮.md')).not.toBeNull()
    expect(findNode(after, '设计规范/规范.md')).toBeNull()
  })

  it('removeNode 删除文件夹时连同子孙一起移除', () => {
    const after = removeNode(sampleTree(), '设计规范')
    expect(collectFileNodes(after).map((node) => node.key)).toEqual(['路线图.pdf'])
  })

  it('patchFile 更新索引状态与更新时间', () => {
    const after = patchFile(sampleTree(), '路线图.pdf', { indexState: 'none', updated: '刚刚' })
    expect(findNode(after, '路线图.pdf')?.file).toMatchObject({
      indexState: 'none',
      updated: '刚刚',
      size: '1 MB'
    })
  })

  it('sortTree 文件夹恒在文件前，文件按 sortKey 排序', () => {
    const tree = mergeUploads(
      [],
      [
        { dirs: [], file: meta('a.pdf', { updated: '9 月 1 日', size: '3 MB' }) },
        { dirs: [], file: meta('b.pdf', { updated: '9 月 9 日', size: '1 MB' }) },
        { dirs: ['资料'], file: meta('c.pdf') }
      ]
    )
    expect(sortTree(tree, 'updated', false).map((node) => node.name)).toEqual([
      '资料',
      'b.pdf',
      'a.pdf'
    ])
    expect(sortTree(tree, 'size', true).map((node) => node.name)).toEqual([
      '资料',
      'b.pdf',
      'a.pdf'
    ])
  })

  it('flattenVisible 折叠文件夹时跳过其子节点，深度随层级递增', () => {
    const tree = sampleTree()
    const all = flattenVisible(tree, () => true)
    expect(all.map((row) => [row.node.key, row.depth])).toEqual([
      ['路线图.pdf', 0],
      ['设计规范', 0],
      ['设计规范/规范.md', 1],
      ['设计规范/组件', 1],
      ['设计规范/组件/按钮.md', 2]
    ])
    const collapsed = flattenVisible(tree, (key) => key !== '设计规范')
    expect(collapsed.map((row) => row.node.key)).toEqual(['路线图.pdf', '设计规范'])
  })

  it('remapKey 只改写命中的标签 key', () => {
    expect(remapKey('a/b', 'a/b', 'a/c')).toBe('a/c')
    expect(remapKey('a/b/d', 'a/b', 'a/c')).toBe('a/c/d')
    expect(remapKey('a/z', 'a/b', 'a/c')).toBe('a/z')
    expect(remapKey('问答', 'a/b', 'a/c')).toBe('问答')
  })
})
