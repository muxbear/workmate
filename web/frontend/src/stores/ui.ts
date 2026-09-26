import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import i18n, { LOCALE_STORAGE_KEY, getInitialLocale } from '@/locales'
import type { LocaleCode } from '@/locales'
import {
  fetchConversations,
  deleteConversation as deleteConversationApi,
} from '@/services/conversationApi'

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
  const searchQuery = ref('')
  const selectedModel = ref('DeepSeek V4')
  const theme = ref<ThemeMode>(getInitialTheme())
  /** 界面语言（迭代 6 T6.6）——与 theme 一样持久化到 localStorage */
  const locale = ref<LocaleCode>(getInitialLocale())
  const histories = ref<HistoryItem[]>([])
  const activeThreadId = ref<string | null>(null)

  /** 右栏占主体宽度的比例（容器宽度尚未测量时为 0） */
  const rightPanelRatio = computed(() =>
    shellWidth.value > 0 ? rightPanelWidth.value / shellWidth.value : 0,
  )

  function initTheme() {
    applyThemeToDocument(theme.value)
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
    searchQuery,
    selectedModel,
    theme,
    locale,
    setLocale,
    histories,
    activeThreadId,
    initTheme,
    setTheme,
    toggleTheme,
    fetchHistories,
    deleteHistory,
    toggleSidebar,
    toggleRightPanel,
    toggleRightPanelFullscreen,
    setRightPanelWidth,
    setRightPanelRatio,
    resetRightPanelWidth,
    syncShellWidth,
    togglePlusMenu,
    closePlusMenu,
    newConversation,
  }
})
