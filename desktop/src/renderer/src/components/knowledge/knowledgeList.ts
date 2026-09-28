/**
 * 知识库列表的纯函数变换
 *
 * 侧栏列表目前是页面内的 mock 数据（无 store、无 IPC），编辑/删除只改这份响应式数据；
 * 抽成纯函数是为了能单测（本仓无 @vue/test-utils，组件内部逻辑无法直接测）。
 * 等知识库引擎落地、列表改由主进程提供时，这些变换可原样复用或替换为 IPC 调用。
 */

export type GroupIcon = 'hard-drive' | 'users' | 'cloud'

/** 条目/分组的来源：本地 index.db 或云端接口 */
export type KnowledgeSource = 'local' | 'cloud'
/** 云端范围：与后端 `GET /api/knowledge-bases?scope=` 及「共享给我的」邀请接口一一对应 */
export type CloudKbScope = 'personal' | 'public' | 'shared_with_me'
/** 本地分组的 kind（与主进程 knowledge_bases.kind 对齐） */
export type KnowledgeKindLike = 'local' | 'shared' | 'cloud'

/** 云条目附带的展示信息（本地条目省略） */
export interface CloudFolderMeta {
  scope: CloudKbScope
  visibility: string
  ownerName: string | null
  /** 分享记录 id（「共享给我的」专用） */
  shareId?: string
  /** 邀请状态：pending 时行内给「接受 / 拒绝」 */
  shareStatus?: string
  permission?: string
}

export interface KnowledgeFolder {
  id: string
  name: string
  description: string
  files: number
  updated: string
  tone: string
  /** 是否置顶（置顶项由服务端排序到最前，列表里也用于显示标记） */
  pinned?: boolean
  /**
   * 条目来源：本地条目进工作台详情，云条目进只读详情。
   * 必填——它是行为分叉点，可选字段会让「忘了赋值」静默走本地分支。
   */
  source: KnowledgeSource
  cloud?: CloudFolderMeta
}

export interface KnowledgeGroup {
  id: string
  label: string
  icon: GroupIcon
  source: KnowledgeSource
  /** source === 'cloud'：后端 scope */
  scope?: CloudKbScope
  /** source === 'local'：本地 index.db 的 kind */
  kind?: KnowledgeKindLike
  items: KnowledgeFolder[]
}

/** 分组三点菜单的项（按来源区分：本地能新建，云端只能刷新） */
export type GroupMenuItem = 'more' | 'create' | 'refresh'

/**
 * 分组菜单项集合。
 *
 * 本地分组：查看更多 + 新建知识库；云分组：查看更多 + 刷新
 * （云端建库涉及配置口径差异，本轮不做——见 `desktop/docs/桌面版知识库实现方案.md` 5.3）。
 */
export function groupMenuItemsOf(group: Pick<KnowledgeGroup, 'source'>): GroupMenuItem[] {
  return group.source === 'cloud' ? ['more', 'refresh'] : ['more', 'create']
}

export function isCloudGroup(group: Pick<KnowledgeGroup, 'source'>): boolean {
  return group.source === 'cloud'
}

/**
 * 云端 ISO 时间 → 展示用日期。
 *
 * 只取日期部分：后端 datetime 是朴素 UTC，直接 `Date.parse` 会被当成本地时间、
 * 整体偏 8 小时（与 Web 版 `updated_at?.split('T')[0]` 同一口径）。
 */
export function cloudDateOf(iso: string): string {
  const value = (iso ?? '').trim()
  if (!value) return '—'
  return value.split('T')[0] || '—'
}

/** 云端知识库 → 列表条目（tone 由调用方注入，保持本模块零依赖） */
export function toCloudFolder(
  item: {
    id: string
    name: string
    description: string
    docsCount: number
    updatedAt: string
    visibility: string
    ownerName: string | null
  },
  scope: CloudKbScope,
  tone: string
): KnowledgeFolder {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    files: item.docsCount,
    updated: cloudDateOf(item.updatedAt),
    tone,
    pinned: false,
    source: 'cloud',
    cloud: {
      scope,
      visibility: item.visibility,
      ownerName: item.ownerName
    }
  }
}

/** 「共享给我的」邀请记录 → 列表条目（待接受项在侧栏行内给接受/拒绝） */
export function toInvitationFolder(
  entry: {
    shareId: string
    kbId: string
    kbName: string
    ownerName: string
    status: string
    permission: string
    createdAt: string
  },
  tone: string
): KnowledgeFolder {
  return {
    id: entry.kbId,
    name: entry.kbName,
    description: entry.ownerName ? `来自 ${entry.ownerName}` : '',
    files: 0,
    updated: cloudDateOf(entry.createdAt),
    tone,
    pinned: false,
    source: 'cloud',
    cloud: {
      scope: 'shared_with_me',
      visibility: '',
      ownerName: entry.ownerName || null,
      shareId: entry.shareId,
      shareStatus: entry.status,
      permission: entry.permission
    }
  }
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
 * 拖拽排序：把 from 位置的知识库移动到 to 位置（to 为移动后的目标下标，越界自动夹取）。
 * 返回新数组，原数组不变；起点非法或位置未变化时原样返回。
 */
export function moveLibrary(items: KnowledgeFolder[], from: number, to: number): KnowledgeFolder[] {
  if (from < 0 || from >= items.length) return items
  const target = Math.min(items.length - 1, Math.max(0, to))
  if (target === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * 把拖拽落点夹取在本区之内：置顶区（pinned）始终排在最前，
 * 未置顶项拖不进置顶区，置顶项也拖不出置顶区，避免落下后立刻被排序规则弹回。
 */
export function clampDropIndex(items: KnowledgeFolder[], from: number, index: number): number {
  if (from < 0 || from >= items.length) return index
  const pinnedCount = items.filter((item) => item.pinned === true).length
  const movingPinned = items[from].pinned === true
  const min = movingPinned ? 0 : pinnedCount
  const max = movingPinned ? Math.max(0, pinnedCount - 1) : items.length - 1
  return Math.min(max, Math.max(min, index))
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
