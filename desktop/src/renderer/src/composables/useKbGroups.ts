import { computed, ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import { useCloudKnowledgeStore } from '@store/cloudKnowledge'
import {
  clampDropIndex,
  isCloudGroup,
  moveLibrary,
  toCloudFolder,
  toInvitationFolder,
  type KnowledgeFolder,
  type KnowledgeGroup
} from '@renderer/components/knowledge/knowledgeList'
import { formatTimestamp } from '@renderer/components/knowledge/kb-display'
import type { KnowledgeBaseSummary, KnowledgeKind } from '../../../shared/contracts'

/**
 * 知识库分组（R6：自 KnowledgePage 外提）。
 *
 * 五个固定分组（本地两组 + 云端三组）+ 分组展开/菜单/新建 + 侧栏条目选中 +
 * 库间拖拽排序与置顶 + 云端分组的状态提示（加载/未授权/失败/空）。
 * 与工作台的交叉点（云库切换、索引进度标签、当前标签）经 Ref/回调注入。
 */

/**
 * 五个固定分组：两组本地来源（本地知识库 / 我的共享知识，按 kind 过滤 index.db），
 * 三组云端来源（按 scope 拉取），分组只决定展示位置。
 *
 * 云分组顺序对齐 Web 版侧栏：公共在个人之前（web/frontend 的 stores/knowledgeBase.ts）。
 *
 * id 刻意与 kind 区分开（`cloud-personal` 而非 `personal`）：分组 id 一旦与
 * `KnowledgeKind` 同名，就又会有人把它当 kind 传给主进程。
 */
const KNOWLEDGE_GROUPS: KnowledgeGroup[] = [
  {
    id: 'local',
    label: '本地知识库',
    icon: 'hard-drive',
    source: 'local',
    kind: 'local',
    items: []
  },
  {
    id: 'cloud-public',
    label: '云公共知识库',
    icon: 'cloud',
    source: 'cloud',
    scope: 'public',
    items: []
  },
  {
    id: 'cloud-personal',
    label: '云个人知识库',
    icon: 'cloud',
    source: 'cloud',
    scope: 'personal',
    items: []
  },
  {
    id: 'shared',
    label: '我的共享知识',
    icon: 'users',
    source: 'local',
    kind: 'shared',
    items: []
  },
  {
    id: 'cloud-shared',
    label: '共享给我的',
    icon: 'users',
    source: 'cloud',
    scope: 'shared_with_me',
    items: []
  }
]

/** 知识库徽标配色：按 id 稳定取色，避免列表刷新时颜色跳动 */
const LIBRARY_TONES = ['#168b7a', '#3b82f6', '#d97706', '#8b5cf6', '#0f9f8a', '#e8793d']
function toneOf(id: string): string {
  let sum = 0
  for (const ch of id) sum += ch.charCodeAt(0)
  return LIBRARY_TONES[sum % LIBRARY_TONES.length]
}

export interface KbGroupsDeps {
  /** 当前打开的云知识库（本组合件可写：选中云库时切换工作台数据源） */
  cloudKb: Ref<KnowledgeFolder | null>
  /** 侧栏条目是否选中：本地库以当前选中知识库为准 */
  selectedLibraryId: Ref<string>
  /** 「查看更多」视图模式（拖拽落点按卡片/表格切换判定半区） */
  moreViewMode: Ref<'card' | 'table'>
  /** 索引进度目标（切库时若指向旧库需关闭其标签） */
  pipelineTarget: Ref<{ kbId: string; relPath: string } | null>
  /** 当前激活标签（切库后回到「问答」） */
  activeTab: Ref<string>
  /** 关闭「索引进度」标签（页面包装 closeTab(INDEX_TAB)） */
  closeIndexTab: () => void
  /** 关闭知识库条目三点菜单（与分组菜单互斥） */
  closeLibMenu: () => void
  /** 轻提示（toast） */
  notify: (text: string) => void
}

export function useKbGroups(deps: KbGroupsDeps) {
  const kbStore = useKnowledgeStore()
  const cloudKbStore = useCloudKnowledgeStore()

  // ── 分组侧栏状态 ──
  /** 折叠状态：缺省展开（新分组不必再去初值里补一笔） */
  const expanded = ref<Record<string, boolean>>({})
  const moreGroupId = ref<string | null>(null)
  const openGroupMenu = ref<string | null>(null)
  /** 新建知识库弹窗：目标分组 */
  const createOpen = ref(false)
  const createKind = ref<KnowledgeKind>('local')

  /** 主进程知识库 → 侧栏条目 */
  function toFolder(base: KnowledgeBaseSummary): KnowledgeFolder {
    return {
      id: base.id,
      name: base.name,
      description: base.description,
      files: base.docsCount,
      updated: formatTimestamp(base.updatedAt),
      tone: toneOf(base.id),
      pinned: base.pinned === true,
      source: 'local'
    }
  }

  /** 云分组 → 条目（个人/公共按 scope 取；「共享给我的」用邀请记录，含待接受项） */
  function cloudItemsOf(group: KnowledgeGroup): KnowledgeFolder[] {
    if (group.scope === 'personal') {
      return cloudKbStore.personal.map((item) => toCloudFolder(item, 'personal', toneOf(item.id)))
    }
    if (group.scope === 'public') {
      return cloudKbStore.publicKbs.map((item) => toCloudFolder(item, 'public', toneOf(item.id)))
    }
    return cloudKbStore.invitations.map((entry) => toInvitationFolder(entry, toneOf(entry.kbId)))
  }

  /** 五个分组：本地按 kind 过滤，云端按 scope 取（空分组保留，用于显示空态与入口） */
  const knowledgeGroups = computed<KnowledgeGroup[]>(() =>
    KNOWLEDGE_GROUPS.map((group) => ({
      ...group,
      items: isCloudGroup(group)
        ? cloudItemsOf(group)
        : kbStore.bases.filter((base) => base.kind === group.kind).map(toFolder)
    }))
  )

  const moreGroup = computed(
    () => knowledgeGroups.value.find((group) => group.id === moreGroupId.value) ?? null
  )

  /** 「查看更多」页：当前分组下的全部知识库（真实数据，不再有占位卡片） */
  const moreLibraries = computed<KnowledgeFolder[]>(() => moreGroup.value?.items ?? [])

  /** 「查看更多」页当前是否为云分组：云分组没有拖拽排序 / 置顶 / 新建 */
  const isCloudMore = computed(() => (moreGroup.value ? isCloudGroup(moreGroup.value) : false))

  /** 云分组的刷新：重新拉取该 scope（本地分组无此入口） */
  async function refreshMoreGroup(): Promise<void> {
    const scope = moreGroup.value?.scope
    if (!scope || scope === 'shared_with_me') {
      await cloudKbStore.loadInvitations()
    } else {
      await cloudKbStore.loadScope(scope)
    }
    deps.notify(cloudKbStore.state === 'ok' ? '已同步云端知识库' : cloudKbStore.message || '同步失败')
  }

  /** 侧栏云分组的空态 / 提示：加载中、未授权、失败、空都有明确去处 */
  function cloudGroupHint(
    group: KnowledgeGroup
  ): { text: string; action: string; run: () => void } | null {
    if (!isCloudGroup(group)) return null
    if (cloudKbStore.loading) return { text: '正在同步云端知识库…', action: '', run: () => {} }
    if (!cloudKbStore.linked) {
      // 没绑 Web 账号时给「去授权」是误导：该做的是先登录（设置 - 账号）
      return { text: cloudKbStore.message || '尚未绑定 Web 账号', action: '', run: () => {} }
    }
    if (cloudKbStore.state === 'auth-required') {
      return {
        text: cloudKbStore.message || '需要授权后才能查看云端知识库',
        action: '去授权',
        run: () => void authorizeCloud()
      }
    }
    if (cloudKbStore.state === 'error') {
      return {
        text: cloudKbStore.message || '同步失败',
        action: '重试',
        run: () => void refreshMoreGroupFrom(group)
      }
    }
    if (group.items.length === 0) {
      return {
        text: group.scope === 'shared_with_me' ? '暂无共享给你的知识库' : '暂无知识库',
        action: '刷新',
        run: () => void refreshMoreGroupFrom(group)
      }
    }
    return null
  }

  /** 侧栏单个云分组刷新（不依赖「查看更多」页） */
  async function refreshMoreGroupFrom(group: KnowledgeGroup): Promise<void> {
    if (group.scope === 'shared_with_me') await cloudKbStore.loadInvitations()
    else if (group.scope) await cloudKbStore.loadScope(group.scope)
  }

  /** 侧栏条目是否选中（云库按 kbId + 分享记录区分；打开云库时不点亮本地条目） */
  function isActiveLibrary(library: KnowledgeFolder): boolean {
    if (library.source === 'cloud') {
      return (
        deps.cloudKb.value?.id === library.id &&
        deps.cloudKb.value?.cloud?.shareId === library.cloud?.shareId
      )
    }
    return deps.cloudKb.value === null && deps.selectedLibraryId.value === library.id
  }

  /** 侧栏条目点击：待接受的邀请还读不到内容，交给行内「接受」按钮处理 */
  function onSidebarLibraryClick(library: KnowledgeFolder): void {
    if (library.cloud?.shareStatus === 'pending') return
    selectLibrary(library)
  }

  /** 用户主动授权（唯一允许打开浏览器的入口），成功后自动重拉 */
  async function authorizeCloud(): Promise<void> {
    const ok = await cloudKbStore.authorize()
    deps.notify(ok ? '已授权，正在同步云端知识库' : cloudKbStore.message || '授权失败')
  }

  /** 「共享给我的」：接受 / 拒绝邀请 */
  async function respondInvitation(library: KnowledgeFolder, accept: boolean): Promise<void> {
    const shareId = library.cloud?.shareId
    if (!shareId) return
    const ok = await cloudKbStore.respondInvitation(shareId, accept)
    deps.notify(
      ok
        ? accept
          ? `已接受「${library.name}」`
          : '已拒绝该分享'
        : cloudKbStore.message || '操作失败'
    )
  }

  // ── 分组操作 ──
  /** 分组是否展开：缺省展开（新增分组不必再去初值里补一笔） */
  const isGroupExpanded = (groupId: string): boolean => expanded.value[groupId] !== false

  /** 折叠/展开只由右侧箭头负责（分组行本身改成了「查看更多」入口） */
  const toggleGroup = (groupId: string): void => {
    expanded.value = { ...expanded.value, [groupId]: !isGroupExpanded(groupId) }
  }

  /**
   * 点分组行 = 打开该分组的「查看更多」。
   *
   * **不弹下拉菜单**：菜单只在悬浮/点击右侧三点按钮时出现，点行直接进列表页
   * （与菜单里的「查看更多」走同一个 `openMoreGroup`，结果一致）。
   */
  const onGroupRowClick = (group: KnowledgeGroup): void => {
    deps.closeLibMenu()
    openMoreGroup(group.id)
  }

  /** 新建知识库：打开弹窗（分组决定 kind），提交后由主进程落库 */
  const addKnowledgeLibrary = (groupId: string): void => {
    // kind 由分组定义给出：分组 id 与 kind 已解耦，不能再拿 groupId 当 kind 用
    const group = KNOWLEDGE_GROUPS.find((item) => item.id === groupId)
    createKind.value = (group?.kind ?? 'local') as KnowledgeKind
    createOpen.value = true
    openGroupMenu.value = null
  }

  /** 新建弹窗提交 */
  const onCreateLibrary = async (payload: {
    name: string
    description: string
  }): Promise<void> => {
    const created = await kbStore.createBase({
      name: payload.name,
      description: payload.description,
      kind: createKind.value
    })
    if (!created) {
      deps.notify(kbStore.lastError || '创建知识库失败')
      return
    }
    toggleGroupOpen(created.kind, true)
    deps.notify(`已创建「${created.name}」`)
  }

  const toggleGroupOpen = (groupId: string, open: boolean): void => {
    expanded.value = { ...expanded.value, [groupId]: open }
  }

  const selectLibrary = (library: KnowledgeFolder): void => {
    if (!library.id) return
    // 侧栏点选一律回到知识库内容（「查看更多」在同一内容区里，不关掉会看不见切换结果）
    moreGroupId.value = null
    if (library.source === 'cloud') {
      // 云库：只读浏览（云端数据不进本地库，也不动本地选中态）
      deps.cloudKb.value = library
      return
    }
    deps.cloudKb.value = null
    // 切库时关掉指向旧库的索引进度标签（面板按 kbId 从 store 取行，留着会指错库）
    if (deps.pipelineTarget.value && deps.pipelineTarget.value.kbId !== library.id) {
      deps.closeIndexTab()
    }
    void kbStore.selectBase(library.id)
    deps.activeTab.value = '问答'
  }

  const selectFromMore = (library: KnowledgeFolder): void => {
    selectLibrary(library)
    moreGroupId.value = null
  }

  const openMoreGroup = (groupId: string): void => {
    openGroupMenu.value = null
    moreGroupId.value = groupId
  }

  /**
   * 点击分组三点按钮：只负责「打开」菜单。
   *
   * 菜单本身由 `@mouseenter` 展开，若这里再做 toggle，鼠标点击会立刻把刚展开的菜单关掉
   * （hover 与 click 互相抵消）；关闭交给移出分组、点击空白处或 Esc。
   */
  const toggleGroupMenu = (groupId: string): void => {
    openGroupMenu.value = groupId
    deps.closeLibMenu()
  }

  // ── 库间拖拽排序 / 置顶（仅「查看更多」页，本地分组） ──
  const draggingLibraryId = ref('')
  const dropTargetId = ref('')
  const dropAfterTarget = ref(false)

  function resetLibraryDrag(): void {
    draggingLibraryId.value = ''
    dropTargetId.value = ''
    dropAfterTarget.value = false
  }

  function onLibraryDragStart(library: KnowledgeFolder, event: DragEvent): void {
    draggingLibraryId.value = library.id
    dropTargetId.value = ''
    dropAfterTarget.value = false
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      // 不写数据时部分平台会直接取消拖拽，写入 id 兜底
      event.dataTransfer.setData('text/plain', library.id)
    }
  }

  /** 悬停判定落点：表格按上下半区，卡片按左右半区 */
  function onLibraryDragOver(library: KnowledgeFolder, event: DragEvent): void {
    if (!draggingLibraryId.value || library.id === draggingLibraryId.value) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropTargetId.value = library.id
    dropAfterTarget.value =
      deps.moreViewMode.value === 'table'
        ? event.clientY - rect.top > rect.height / 2
        : event.clientX - rect.left > rect.width / 2
  }

  /** 落下：把可视顺序换算成新顺序并写库（置顶区不可跨越，落点先夹取） */
  async function onLibraryDrop(): Promise<void> {
    // 云分组不参与本地排序（拖拽在模板上已禁用，这里是双保险：避免云端库 id 被当成本地 kind 传给主进程）
    if (isCloudMore.value) return
    const source = draggingLibraryId.value
    const target = dropTargetId.value
    const after = dropAfterTarget.value
    resetLibraryDrag()
    const groupId = moreGroupId.value
    if (!source || !target || source === target || !groupId) return
    const items = moreLibraries.value
    const from = items.findIndex((item) => item.id === source)
    const targetIndex = items.findIndex((item) => item.id === target)
    if (from < 0 || targetIndex < 0) return
    // 落点在目标之前 / 之后；拖拽项被摘除后，其后面的下标整体前移一位
    let to = after ? targetIndex + 1 : targetIndex
    if (from < to) to -= 1
    to = clampDropIndex(items, from, to)
    if (to === from) return
    const next = moveLibrary(items, from, to)
    const ok = await kbStore.reorderBases(
      groupId as KnowledgeKind,
      next.map((item) => item.id)
    )
    if (!ok) deps.notify(kbStore.lastError || '保存排序失败，请重试')
  }

  /** 置顶 / 取消置顶：置顶项固定排在最前，顺序以主进程返回为准 */
  async function toggleLibraryPin(library: KnowledgeFolder): Promise<void> {
    if (library.source === 'cloud') return // 云库排序由服务端决定，本地不改
    const pinned = library.pinned === true
    const ok = await kbStore.setPinned(library.id, !pinned)
    if (!ok) {
      deps.notify(kbStore.lastError || (pinned ? '取消置顶失败' : '置顶失败'))
      return
    }
    deps.notify((pinned ? '已取消置顶「' : '已置顶「') + library.name + '」')
  }

  return {
    toFolder,
    toneOf,
    expanded,
    moreGroupId,
    openGroupMenu,
    createOpen,
    createKind,
    knowledgeGroups,
    moreGroup,
    moreLibraries,
    isCloudMore,
    refreshMoreGroup,
    cloudGroupHint,
    refreshMoreGroupFrom,
    isActiveLibrary,
    onSidebarLibraryClick,
    authorizeCloud,
    respondInvitation,
    isGroupExpanded,
    toggleGroup,
    onGroupRowClick,
    addKnowledgeLibrary,
    onCreateLibrary,
    toggleGroupOpen,
    selectLibrary,
    selectFromMore,
    openMoreGroup,
    toggleGroupMenu,
    draggingLibraryId,
    dropTargetId,
    dropAfterTarget,
    resetLibraryDrag,
    onLibraryDragStart,
    onLibraryDragOver,
    onLibraryDrop,
    toggleLibraryPin
  }
}
