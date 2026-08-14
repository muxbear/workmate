import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchConversations, deleteConversation as deleteConversationApi } from '@/services/conversationApi'

export interface HistoryItem {
  thread_id: string
  title: string
}

export type ThemeMode = 'light' | 'dark'

const THEME_STORAGE_KEY = 'ui_theme'
const DEFAULT_THEME: ThemeMode = 'light'

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
}

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const rightPanelCollapsed = ref(false)
  const plusMenuOpen = ref(false)
  const searchQuery = ref('')
  const selectedModel = ref('DeepSeek V4')
  const theme = ref<ThemeMode>(getInitialTheme())
  const histories = ref<HistoryItem[]>([])
  const activeThreadId = ref<string | null>(null)

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

  async function fetchHistories() {
    try {
      const data = await fetchConversations()
      histories.value = data.map((c) => (
        {
          thread_id: c.thread_id,
          title: c.title,
        }
      ))
    } catch {
      // 静默失败, 列表保持现状
    }
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleRightPanel() {
    rightPanelCollapsed.value = !rightPanelCollapsed.value
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
  }

  return {
      sidebarCollapsed,
      rightPanelCollapsed,
      plusMenuOpen,
      searchQuery,
      selectedModel,
      theme,
      histories,
      activeThreadId,
      initTheme,
      setTheme,
      toggleTheme,
      fetchHistories,
      deleteHistory,
      toggleSidebar,
      toggleRightPanel,
      togglePlusMenu,
      closePlusMenu,
      newConversation,
  }
})
