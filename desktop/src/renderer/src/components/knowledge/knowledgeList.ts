/**
 * 知识库列表的纯函数变换
 *
 * 侧栏列表目前是页面内的 mock 数据（无 store、无 IPC），编辑/删除只改这份响应式数据；
 * 抽成纯函数是为了能单测（本仓无 @vue/test-utils，组件内部逻辑无法直接测）。
 * 等知识库引擎落地、列表改由主进程提供时，这些变换可原样复用或替换为 IPC 调用。
 */

export type GroupIcon = 'hard-drive' | 'users' | 'cloud'

export interface KnowledgeFolder {
  id: string
  name: string
  description: string
  files: number
  updated: string
  tone: string
}

export interface KnowledgeGroup {
  id: string
  label: string
  icon: GroupIcon
  items: KnowledgeFolder[]
}

/** 扁平化所有分组下的知识库 */
export function allLibraries(groups: KnowledgeGroup[]): KnowledgeFolder[] {
  return groups.flatMap((group) => group.items)
}

/** 某个知识库所属分组 id（不存在返回 null） */
export function findGroupIdOf(groups: KnowledgeGroup[], libraryId: string): string | null {
  return groups.find((group) => group.items.some((item) => item.id === libraryId))?.id ?? null
}

/**
 * 重命名/改描述：不可变替换，其余引用保持不动。
 * 配置以 id 为键，改名不影响任何配置（注意：不要在这里搬动按库配置）。
 */
export function renameLibrary(
  groups: KnowledgeGroup[],
  libraryId: string,
  patch: { name: string; description: string }
): KnowledgeGroup[] {
  return groups.map((group) =>
    group.items.some((item) => item.id === libraryId)
      ? {
          ...group,
          items: group.items.map((item) =>
            item.id === libraryId ? { ...item, ...patch, updated: '刚刚' } : item
          )
        }
      : group
  )
}

/** 删除某知识库（不可变替换）；分组本身保留，允许为空 */
export function removeLibrary(groups: KnowledgeGroup[], libraryId: string): KnowledgeGroup[] {
  return groups.map((group) =>
    group.items.some((item) => item.id === libraryId)
      ? { ...group, items: group.items.filter((item) => item.id !== libraryId) }
      : group
  )
}

/**
 * 删除后的选中兜底：优先原分组（preferredGroupId）的首项，其次全局首项，全空返回 null。
 * 调用方在得到 null 时应保留原选中引用——详情区只做属性读取，不会报错。
 */
export function pickSelectionAfterRemoval(
  groups: KnowledgeGroup[],
  preferredGroupId: string | null
): KnowledgeFolder | null {
  const preferred = preferredGroupId
    ? groups.find((group) => group.id === preferredGroupId)
    : undefined
  if (preferred?.items.length) return preferred.items[0]
  return allLibraries(groups)[0] ?? null
}
