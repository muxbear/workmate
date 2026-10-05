import { computed, nextTick, ref, watch, type Ref } from 'vue'

/**
 * 知识库工作台布局（R6：自 KnowledgePage 外提）。
 *
 * - 左侧分组栏 / 右侧内容区 拖拽分栏（宽度 180~420px 且给内容区留位，松手写 localStorage，双击恢复默认）；
 * - 文件区 / 问答区 拖拽分栏（28%~65%）；
 * - 问答区域折叠 / 展开 / 全屏（默认折叠）；
 * - 标签栏横向滚动按钮显隐与左右翻页。
 *
 * 两个元素 ref（文件区容器、标签栏）由页面持有并绑定在模板上，随参数注入。
 */

const GROUPS_WIDTH_KEY = 'ke-work.kb-groups-width'
const GROUPS_WIDTH_DEFAULT = 250
const GROUPS_WIDTH_MIN = 180
const GROUPS_WIDTH_MAX = 420

export interface KbLayoutDeps {
  /** 文件区容器元素 ref（问答分栏拖拽的参考矩形） */
  detailRef: Ref<HTMLElement | null>
  /** 标签栏元素 ref（滚动按钮显隐） */
  tabBarRef: Ref<HTMLElement | null>
  /** 已打开的标签（变化后刷新滚动按钮） */
  openTabs: Ref<string[]>
}

export function useKbLayout(deps: KbLayoutDeps) {
  // ── 左侧分组栏宽度 ──
  /** 读取本地记住的侧栏宽度（非法/越界值回退默认） */
  function readGroupsWidth(): number {
    const saved = Number(localStorage.getItem(GROUPS_WIDTH_KEY))
    if (!Number.isFinite(saved) || saved <= 0) return GROUPS_WIDTH_DEFAULT
    return Math.min(GROUPS_WIDTH_MAX, Math.max(GROUPS_WIDTH_MIN, saved))
  }

  const groupsWidth = ref(readGroupsWidth())

  /**
   * 拖动分组栏右侧的分割栏调整它的宽度：
   * 结果限制在 180~420px，同时给右侧内容区留出足够空间，松手后写入本地。
   */
  const resizeGroups = (event: MouseEvent): void => {
    event.preventDefault()
    const workbench = (event.currentTarget as HTMLElement | null)?.parentElement
    const total = workbench?.clientWidth ?? 0
    const maxWidth = total
      ? Math.max(GROUPS_WIDTH_MIN, Math.min(GROUPS_WIDTH_MAX, total - 460))
      : GROUPS_WIDTH_MAX
    const startX = event.clientX
    const startWidth = groupsWidth.value
    const onMove = (moveEvent: MouseEvent): void => {
      groupsWidth.value = Math.min(
        maxWidth,
        Math.max(GROUPS_WIDTH_MIN, startWidth + moveEvent.clientX - startX)
      )
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem(GROUPS_WIDTH_KEY, String(groupsWidth.value))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /** 双击分割栏恢复默认宽度 */
  const resetGroupsWidth = (): void => {
    groupsWidth.value = GROUPS_WIDTH_DEFAULT
    localStorage.setItem(GROUPS_WIDTH_KEY, String(GROUPS_WIDTH_DEFAULT))
  }

  // ── 问答区域：折叠 / 展开 / 全屏（默认折叠 = 整块区域不显示）──
  /**
   * - 折叠（默认）：整个问答区域收起不显示，知识库内容区域占满工作台，右侧只留一条展开入口
   * - 展开：重新显示问答区域（恢复拖拽出来的分栏宽度）
   * - 全屏：整块工作台都交给问答区域
   *
   * 展开 / 折叠由同一个按钮承担：收起时只显示「展开」，显示时只显示「折叠」。
   */
  const panelCollapsed = ref(true)
  const panelFullscreen = ref(false)
  /** 默认 60%：典型窗口下文件区 ≈570px（表格六列紧凑档，观感与旧版连续）；
   *  左拖下限由 .kb-files 的 min-width 400px 兜底，不再被表格宽度硬顶到拖不动 */
  const filePanelPercent = ref(60)

  const togglePanelCollapsed = (): void => {
    // 全屏时点它先退出全屏，再收起区域
    if (panelFullscreen.value) {
      panelFullscreen.value = false
      panelCollapsed.value = true
      return
    }
    panelCollapsed.value = !panelCollapsed.value
  }

  /** 全屏 / 还原：全屏时按钮切成「还原」，还原回展开（分栏）状态 */
  const togglePanelFullscreen = (): void => {
    panelFullscreen.value = !panelFullscreen.value
    // 全屏必然处于显示状态；退出全屏后回到展开的分栏宽度
    panelCollapsed.value = false
  }

  /** 收起时知识库内容区域占满工作台，显示时按拖拽出来的分栏比例 */
  const filePanelStyle = computed<Record<string, string>>(() => {
    const style: Record<string, string> = {}
    if (!panelCollapsed.value) style.width = `${filePanelPercent.value}%`
    return style
  })

  // ── 文件区 / 问答区 拖拽分栏 ──
  const resizePanels = (event: MouseEvent): void => {
    event.preventDefault()
    const rect = deps.detailRef.value?.getBoundingClientRect()
    if (!rect) return
    const onMove = (moveEvent: MouseEvent): void => {
      filePanelPercent.value = Math.min(
        65,
        Math.max(28, ((moveEvent.clientX - rect.left) / rect.width) * 100)
      )
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── 标签栏滚动按钮显隐 ──
  const tabScroll = ref({ left: false, right: false })

  const updateTabScroll = (): void => {
    const el = deps.tabBarRef.value
    if (!el) return
    tabScroll.value = {
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    }
  }

  const moveTabs = (direction: -1 | 1): void => {
    deps.tabBarRef.value?.scrollBy({ left: direction * 180, behavior: 'smooth' })
    window.setTimeout(updateTabScroll, 250)
  }

  watch(deps.openTabs, () => {
    nextTick(updateTabScroll)
  })

  return {
    groupsWidth,
    resizeGroups,
    resetGroupsWidth,
    panelCollapsed,
    panelFullscreen,
    togglePanelCollapsed,
    togglePanelFullscreen,
    filePanelStyle,
    filePanelPercent,
    resizePanels,
    tabScroll,
    updateTabScroll,
    moveTabs
  }
}
