import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import i18n, { LOCALE_STORAGE_KEY, getInitialLocale } from '@/locales'
import type { LocaleCode } from '@/locales'
import {
  fetchConversations,
  deleteConversation as deleteConversationApi,
} from '@/services/conversationApi'
import { fetchPreferences, updatePreferences } from '@/services/settingsApi'
import type { NotificationSound, UserPreferences } from '@/types/settings'

export interface HistoryItem {
  thread_id: string
  title: string
}

export type ThemeMode = 'light' | 'dark'

const THEME_STORAGE_KEY = 'ui_theme'
const DEFAULT_THEME: ThemeMode = 'light'

/** 右栏展开时的默认宽度（px） */
export const DEFAULT_RIGHT_PANEL_WIDTH = 280
/** 右栏最小宽度（px） */
export const MIN_RIGHT_PANEL_WIDTH = 240
/** 对话区最小宽度（px），拖拽分割线时用于约束右栏最大宽度 */
export const MIN_CHAT_WIDTH = 360
/** 右栏收起后的轨道宽度（px） */
export const RIGHT_PANEL_COLLAPSED_WIDTH = 40

/** 把右栏宽度约束到 [右栏最小宽度, 容器宽度 - 对话区最小宽度] 区间 */
export function clampRightPanelWidth(width: number, shellWidth: number): number {
  if (shellWidth <= 0) return Math.max(Math.round(width), MIN_RIGHT_PANEL_WIDTH)
  const max = Math.max(MIN_RIGHT_PANEL_WIDTH, shellWidth - MIN_CHAT_WIDTH)
  return Math.round(Math.min(Math.max(width, MIN_RIGHT_PANEL_WIDTH), max))
}

function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // 忽略本地存储不可用的场景
  }
  return DEFAULT_THEME
}

function applyThemeToDocument(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  // Element Plus 深色变量表挂在 html.dark 下，需要同步切换
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/** 默认字号——缩放系数为 1.0（现有视觉不变）。桌面版同样以 17 为基准。 */
export const DEFAULT_FONT_SIZE = 17
/** 字号下限 */
export const FONT_SIZE_MIN = 12
/** 字号上限 */
export const FONT_SIZE_MAX = 24
const FONT_SIZE_STORAGE_KEY = 'ui_font_size'

/** 把字号收敛到 [12, 24]；非数字回落到默认值 */
export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)))
}

/**
 * 读取初始字号。
 *
 * 与 theme / locale 一样**必须先于服务端可读**：等接口回来再应用，
 * 页面会先按 17 渲染再跳一下，字号越大幅度越明显。
 * `index.html` 的内联脚本做了同样的事，避免首帧闪烁。
 */
function getInitialFontSize(): number {
  try {
    const stored = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY))
    if (Number.isFinite(stored) && stored >= FONT_SIZE_MIN && stored <= FONT_SIZE_MAX) {
      return Math.round(stored)
    }
  } catch {
    // 忽略本地存储不可用的场景
  }
  return DEFAULT_FONT_SIZE
}

/**
 * 字号对应的根元素 `zoom` 取值；返回 null 表示「不需要缩放，应移除该内联样式」。
 *
 * 抽成纯函数是为了可测：jsdom 的 `CSSStyleDeclaration` 不支持 `zoom`
 * （非标准属性），`setProperty('zoom', …)` 会被静默丢弃，DOM 断言在单测里
 * 永远读到空串——比例的换算只能这样单独钉住，真实效果靠浏览器验证。
 */
export function fontZoomValue(size: number): string | null {
  const factor = clampFontSize(size) / DEFAULT_FONT_SIZE
  return factor === 1 ? null : String(factor)
}

/**
 * 应用字号缩放。
 *
 * 用根元素 `zoom` 而不是覆盖 `--font-size-*` 令牌：全仓有 279 处硬编码
 * `font-size: Npx`，改令牌只覆盖走变量的那些，**也缩放不了固定高度**
 * （`--topbar-height` 52px、按钮 36px）——字号调大后文字会直接在容器里被裁掉。
 * `zoom` 缩放整页，也正是桌面版 `setZoomFactor(fontSize / 17)` 的 CSS 对应物。
 *
 * 已知代价：`zoom` 会改变 `clientX` / `getBoundingClientRect()` 与内联 px 的
 * 换算关系，三个拖拽 composable（usePanelResize / useDragSort / useKbQaResize）
 * 需要真机验证；媒体查询也不跟随 zoom。
 */
function applyFontSize(size: number) {
  if (typeof document === 'undefined') return
  const value = fontZoomValue(size)
  const root = document.documentElement
  if (value === null) {
    // 1.0 时不留内联样式，避免污染 DOM 快照
    root.style.removeProperty('zoom')
  } else {
    root.style.setProperty('zoom', value)
  }
}

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  /** 右栏默认收起：进入对话页先只展示对话区，需要时再展开 */
  const rightPanelCollapsed = ref(true)
  /** 右栏是否全屏：占满主体宽度、隐藏左侧对话区 */
  const rightPanelFullscreen = ref(false)
  /** 右栏展开宽度（px）；收起时保留该值，再次展开可还原 */
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)
  /** 主体容器实测宽度（由 AppShell 上报），用于按比例调整右栏宽度 */
  const shellWidth = ref(0)
  const plusMenuOpen = ref(false)
  /**
   * 设置窗口是否打开。
   *
   * 放在 store 而不是某个组件的局部状态：打开它的 `TopBar` 与渲染它的
   * `MainLayout` 是兄弟节点，没有共同的局部作用域。
   */
  const settingsOpen = ref(false)
  const searchQuery = ref('')
  const selectedModel = ref('DeepSeek V4')
  const theme = ref<ThemeMode>(getInitialTheme())
  /** 界面语言（迭代 6 T6.6）——与 theme 一样持久化到 localStorage */
  const locale = ref<LocaleCode>(getInitialLocale())
  /** 界面字号——同时持久化到 localStorage 与服务端（按用户） */
  const fontSize = ref<number>(getInitialFontSize())
  /** 客户端通知开关。刻意不落 localStorage：它首屏不渲染任何东西，
   *  只在收到通知时被读（那必然是登录之后），落本地只会制造跨用户泄漏。 */
  const clientNotifications = ref(true)
  /** 提示音风格。同上，不落 localStorage。 */
  const notificationSound = ref<NotificationSound>('none')
  /**
   * 记录「已为哪个用户加载过偏好」。
   *
   * 用 userId 而不是布尔 `loaded`：布尔 guard 会让第二个登录的用户**永远拉不到**
   * 自己的偏好，静默继承上一个人的设置。
   */
  const prefsLoadedFor = ref<string | null>(null)
  /**
   * 最近一次与服务端一致的字号。
   *
   * 滑块是"本地跟手、松手提交"的：拖动过程中本地值已经变了，失败时要回滚到
   * **服务端确认过的那个值**，而不是"本次改动之前的值"——后者早已被覆盖。
   */
  const confirmedFontSize = ref(DEFAULT_FONT_SIZE)
  const histories = ref<HistoryItem[]>([])
  const activeThreadId = ref<string | null>(null)

  /** 右栏占主体宽度的比例（容器宽度尚未测量时为 0） */
  const rightPanelRatio = computed(() =>
    shellWidth.value > 0 ? rightPanelWidth.value / shellWidth.value : 0,
  )

  /**
   * 当前字号缩放系数（1 = 未缩放）。
   *
   * 拖拽类交互需要它把**视觉坐标换算回布局坐标**：`getBoundingClientRect()` 与
   * `MouseEvent.clientX` 都是 zoom 之后的视觉 px，而宽度、`clientWidth` 是布局 px，
   * 两者在字号 ≠ 1 时差一个系数，混用会让分割线不跟手、上下界也偏。
   */
  const fontScale = computed(() => clampFontSize(fontSize.value) / DEFAULT_FONT_SIZE)

  /** 应用外观设置（主题 + 字号）。启动时调用一次，早于挂载。 */
  function initAppearance() {
    applyThemeToDocument(theme.value)
    applyFontSize(fontSize.value)
  }

  function setTheme(mode: ThemeMode) {
    theme.value = mode
    applyThemeToDocument(mode)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      // 忽略本地存储不可用的场景
    }
  }

  function toggleTheme() {
    setTheme(theme.value === 'light' ? 'dark' : 'light')
  }

  /** 切换界面语言：改 i18n 实例的 locale 并持久化，下次打开仍是它 */
  function setLocale(next: LocaleCode) {
    locale.value = next
    i18n.global.locale.value = next
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // 忽略本地存储不可用的场景
    }
  }

  /** 设置字号：立即应用缩放并持久化到本地 */
  function setFontSize(next: number) {
    const size = clampFontSize(next)
    fontSize.value = size
    applyFontSize(size)
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(size))
    } catch {
      // 忽略本地存储不可用的场景
    }
  }

  // 偏好写入串行化：各控件一次只发一个 PUT，但两个在途请求理论上可能乱序落库，
  // 串成一条链就消除了这一类问题。
  let prefWriteChain: Promise<unknown> = Promise.resolve()

  function persistPreferences(patch: Partial<UserPreferences>): Promise<unknown> {
    prefWriteChain = prefWriteChain.catch(() => {}).then(() => updatePreferences(patch))
    return prefWriteChain
  }

  /**
   * 切换语言并写入服务端。
   *
   * 本地先生效（与 TopBar 的切换器共用 `setLocale`，所以两处不可能不同步），
   * 写失败则回滚——否则界面显示的和库里存的不一致。
   */
  async function saveLanguage(next: LocaleCode) {
    const previous = locale.value
    setLocale(next)
    try {
      await persistPreferences({ language: next })
    } catch (error) {
      setLocale(previous)
      throw error
    }
  }

  /**
   * 把当前字号写入服务端。
   *
   * **不设本地值**：滑块在 `input` 阶段已经把本地值改成了用户拖到的位置，
   * 这里只负责提交。失败时回滚到最近一次与服务端一致的字号
   * （而不是"改之前的值"——那个值在拖动过程中已经被覆盖掉了）。
   */
  async function persistFontSize(next: number) {
    const size = clampFontSize(next)
    try {
      await persistPreferences({ fontSize: size })
      confirmedFontSize.value = size
    } catch (error) {
      setFontSize(confirmedFontSize.value)
      throw error
    }
  }

  /** 一步到位的字号设置：改本地 + 写服务端（失败回滚） */
  async function saveFontSize(next: number) {
    setFontSize(next)
    await persistFontSize(next)
  }

  /** 设置客户端通知开关并写入服务端（权限拒绝的判定在调用方，这里只管落值） */
  function setClientNotifications(next: boolean) {
    clientNotifications.value = next
    void persistPreferences({ clientNotifications: next })
  }

  /** 设置提示音并写入服务端 */
  function setNotificationSound(next: NotificationSound) {
    notificationSound.value = next
    void persistPreferences({ notificationSound: next })
  }

  /**
   * 拉取服务端偏好并应用。
   *
   * 幂等：同一 userId 只拉一次，路由来回切换导致的重挂载是 no-op。
   * 失败时保持本地语言与字号（localStorage 里已有值），不打断使用，
   * 也不置 `prefsLoadedFor`，下次挂载会重试。
   */
  async function loadPreferences(userId: string | null) {
    if (!userId || prefsLoadedFor.value === userId) return
    try {
      const prefs = await fetchPreferences()
      setLocale(prefs.language)
      setFontSize(prefs.fontSize)
      clientNotifications.value = prefs.clientNotifications
      notificationSound.value = prefs.notificationSound
      confirmedFontSize.value = clampFontSize(prefs.fontSize)
      prefsLoadedFor.value = userId
    } catch {
      // 静默失败：沿用本地值
    }
  }

  /**
   * 登出清理。
   *
   * 必须清 `prefsLoadedFor`：否则下一个登录的用户会因为 guard 命中而永远拉不到
   * 自己的偏好。复位字号会立刻撤掉 zoom，下一个人不会在请求回来之前先看到
   * 上一个人的大字号。
   */
  function clearPreferences() {
    prefsLoadedFor.value = null
    clientNotifications.value = true
    notificationSound.value = 'none'
    confirmedFontSize.value = DEFAULT_FONT_SIZE
    setFontSize(DEFAULT_FONT_SIZE)
  }

  async function fetchHistories() {
    try {
      const data = await fetchConversations()
      histories.value = data.map((c) => ({
        thread_id: c.thread_id,
        title: c.title,
      }))
    } catch {
      // 静默失败, 列表保持现状
    }
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  /** 侧栏收起前的用户偏好——窄屏自动收起后，变宽要还原成它，而不是粗暴展开 */
  let sidebarPreference: boolean | null = null
  let sidebarQuery: MediaQueryList | null = null

  /**
   * 按视口宽度自动收起/展开侧栏（迭代 6 T6.6）。
   *
   * 此前折叠**只能手动点**：`SideMenu` 是硬 240px 且带 `min-width`，永远不会自己收缩，
   * 窄屏下被挤扁的是内容区。方案 `:1322` 的验收是"窄屏（1280/768）布局不破"。
   *
   * 用 `matchMedia` 而不是监听 resize：只在跨过阈值时触发一次，不必每像素重算。
   * 照 `ChatPlusMenu.vue` 的既有写法（含 change 监听与卸载）。
   *
   * Returns:
   *     卸载函数，供组件 `onBeforeUnmount` 调用。
   */
  function initResponsiveSidebar(): () => void {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {}

    sidebarQuery = window.matchMedia('(max-width: 1279px)')
    const apply = (narrow: boolean) => {
      if (narrow) {
        // 记住用户原本的选择：变宽时要还给他，而不是一律展开
        if (sidebarPreference === null) sidebarPreference = sidebarCollapsed.value
        sidebarCollapsed.value = true
      } else if (sidebarPreference !== null) {
        sidebarCollapsed.value = sidebarPreference
        sidebarPreference = null
      }
    }
    apply(sidebarQuery.matches)

    const onChange = (e: MediaQueryListEvent) => apply(e.matches)
    sidebarQuery.addEventListener('change', onChange)
    return () => {
      sidebarQuery?.removeEventListener('change', onChange)
      sidebarQuery = null
    }
  }

  function toggleRightPanel() {
    rightPanelCollapsed.value = !rightPanelCollapsed.value
    // 收起时一并退出全屏，避免再次展开直接铺满整页
    if (rightPanelCollapsed.value) rightPanelFullscreen.value = false
  }

  /** 右栏全屏 / 还原（全屏时右栏占满主体宽度，隐藏对话区） */
  function toggleRightPanelFullscreen() {
    rightPanelFullscreen.value = !rightPanelFullscreen.value
    if (rightPanelFullscreen.value) rightPanelCollapsed.value = false
  }

  /** 设置右栏宽度（自动按容器宽度收敛到合法区间） */
  function setRightPanelWidth(width: number) {
    rightPanelWidth.value = clampRightPanelWidth(width, shellWidth.value)
  }

  /** 按比例设置右栏宽度（打开文档标签页时使用 1:1） */
  function setRightPanelRatio(ratio: number) {
    if (shellWidth.value <= 0) return
    setRightPanelWidth(shellWidth.value * ratio)
  }

  /** 还原默认右栏宽度（双击分割线） */
  function resetRightPanelWidth() {
    setRightPanelWidth(DEFAULT_RIGHT_PANEL_WIDTH)
  }

  /** 主体容器尺寸变化时同步，并把右栏宽度收敛回合法区间 */
  function syncShellWidth(width: number) {
    shellWidth.value = width
    if (width > 0) setRightPanelWidth(rightPanelWidth.value)
  }

  function togglePlusMenu() {
    plusMenuOpen.value = !plusMenuOpen.value
  }

  function closePlusMenu() {
    plusMenuOpen.value = false
  }

  function openSettings() {
    settingsOpen.value = true
  }

  function closeSettings() {
    settingsOpen.value = false
  }

  async function deleteHistory(thread_id: string) {
    try {
      await deleteConversationApi(thread_id)
      histories.value = histories.value.filter((h) => h.thread_id != thread_id)
      if (activeThreadId.value == thread_id) {
        activeThreadId.value = null
      }
    } catch {
      // 静默失败
    }
  }

  function newConversation() {
    activeThreadId.value = null
    plusMenuOpen.value = false
    // 新建对话后回到对话区，顺带退出右栏全屏
    rightPanelFullscreen.value = false
  }

  return {
    sidebarCollapsed,
    rightPanelCollapsed,
    rightPanelFullscreen,
    rightPanelWidth,
    shellWidth,
    rightPanelRatio,
    plusMenuOpen,
    settingsOpen,
    searchQuery,
    selectedModel,
    theme,
    locale,
    fontSize,
    fontScale,
    clientNotifications,
    notificationSound,
    prefsLoadedFor,
    setLocale,
    setFontSize,
    saveLanguage,
    saveFontSize,
    persistFontSize,
    setClientNotifications,
    setNotificationSound,
    loadPreferences,
    clearPreferences,
    histories,
    activeThreadId,
    initAppearance,
    setTheme,
    toggleTheme,
    fetchHistories,
    deleteHistory,
    toggleSidebar,
    initResponsiveSidebar,
    toggleRightPanel,
    toggleRightPanelFullscreen,
    setRightPanelWidth,
    setRightPanelRatio,
    resetRightPanelWidth,
    syncShellWidth,
    togglePlusMenu,
    closePlusMenu,
    openSettings,
    closeSettings,
    newConversation,
  }
})
