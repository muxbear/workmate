import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ChatArtifact } from '@/types/chat'

/** 固定标签页 key：历史对话 */
export const HISTORY_TAB_KEY = 'history'

/** 右侧工作区已打开的文档标签页 */
export interface DocumentTab {
  /** 唯一键：会话 + 产物路径 */
  key: string
  path: string
  name: string
  threadId: string
  mimeType?: string
  size?: number
  createdAt: number
}

/**
 * 右侧工作区标签页状态：
 * 「历史对话」为固定标签，其余标签由点击消息中的产物文件打开，可关闭。
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<DocumentTab[]>([])
  const activeKey = ref<string>(HISTORY_TAB_KEY)

  const activeTab = computed<DocumentTab | null>(
    () => tabs.value.find((tab) => tab.key === activeKey.value) ?? null,
  )
  const historyActive = computed(() => activeKey.value === HISTORY_TAB_KEY)

  function buildKey(threadId: string, path: string): string {
    return (threadId || 'local') + '::' + path
  }

  /** 打开（或激活）文档标签页，返回是否为本次新开 */
  function openDocument(artifact: ChatArtifact, threadId: string): boolean {
    const key = buildKey(threadId, artifact.path)
    const exists = tabs.value.some((tab) => tab.key === key)
    if (!exists) {
      tabs.value = [
        ...tabs.value,
        {
          key,
          path: artifact.path,
          name: artifact.name || artifact.path.split('/').pop() || '未命名文件',
          threadId,
          mimeType: artifact.mime_type,
          size: artifact.size,
          createdAt: artifact.created_at || Date.now(),
        },
      ]
    }
    activeKey.value = key
    return !exists
  }

  function activateTab(key: string) {
    activeKey.value = key
  }

  function activateHistory() {
    activeKey.value = HISTORY_TAB_KEY
  }

  /** 关闭标签页：当前标签被关闭时优先激活右侧相邻标签，其次左侧，最后回到历史对话 */
  function closeTab(key: string) {
    const index = tabs.value.findIndex((tab) => tab.key === key)
    if (index === -1) return
    tabs.value = tabs.value.filter((tab) => tab.key !== key)
    if (activeKey.value !== key) return
    const next = tabs.value[index] ?? tabs.value[index - 1] ?? null
    activeKey.value = next ? next.key : HISTORY_TAB_KEY
  }

  /** 清空全部文档标签页（新建对话 / 删除当前会话时调用） */
  function closeAllTabs() {
    tabs.value = []
    activeKey.value = HISTORY_TAB_KEY
  }

  return {
    tabs,
    activeKey,
    activeTab,
    historyActive,
    openDocument,
    activateTab,
    activateHistory,
    closeTab,
    closeAllTabs,
  }
})
