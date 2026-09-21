import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { ArtifactStatus, ChatArtifact } from '@/types/chat'

/** 固定标签页 key：历史对话 */
export const HISTORY_TAB_KEY = 'history'

/** 右侧工作区已打开的文档标签页 */
export interface DocumentTab {
  /** 唯一键：会话 + 产物标识 */
  key: string
  path: string
  name: string
  threadId: string
  /** 产物持久化 ID（缺省时回退为路径） */
  artifactId?: string
  /** 产物持久化状态（expired 时预览直接提示不可恢复） */
  status?: ArtifactStatus
  mimeType?: string
  size?: number
  createdAt: number
}

/**
 * 右侧工作区标签页状态：
 * 「历史对话」为固定标签，其余标签由点击消息中的产物文件打开，可关闭。
 */
/** 标签页持久化的本地存储键（刷新后自动恢复） */
const STORAGE_KEY = 'ke-work:workspace-tabs'

/** 校验持久化数据是否为合法的标签页 */
function isDocumentTab(value: unknown): value is DocumentTab {
  if (!value || typeof value !== 'object') return false
  const tab = value as Partial<DocumentTab>
  return (
    typeof tab.key === 'string' &&
    typeof tab.path === 'string' &&
    typeof tab.threadId === 'string'
  )
}

/** 读取上次保留的标签页（无有效数据时回到历史对话） */
function readPersistedTabs(): { tabs: DocumentTab[]; activeKey: string } {
  const empty = { tabs: [] as DocumentTab[], activeKey: HISTORY_TAB_KEY }
  if (typeof localStorage === 'undefined') return empty
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeKey?: unknown }
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isDocumentTab) : []
    const activeKey =
      typeof parsed.activeKey === 'string' && tabs.some((tab) => tab.key === parsed.activeKey)
        ? parsed.activeKey
        : HISTORY_TAB_KEY
    return { tabs, activeKey }
  } catch {
    return empty
  }
}

/** 持久化标签页（隐私模式或配额不足时静默忽略） */
function persistTabs(tabs: DocumentTab[], activeKey: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeKey }))
  } catch {
    // 写入失败不影响标签页功能
  }
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const persisted = readPersistedTabs()
  const tabs = ref<DocumentTab[]>(persisted.tabs)
  const activeKey = ref<string>(persisted.activeKey)

  // 标签页或激活项变化时写入本地存储，刷新页面后自动恢复
  watch([tabs, activeKey], ([nextTabs, nextKey]) => persistTabs(nextTabs, nextKey), {
    deep: true,
    flush: 'sync',
  })

  const activeTab = computed<DocumentTab | null>(
    () => tabs.value.find((tab) => tab.key === activeKey.value) ?? null,
  )
  const historyActive = computed(() => activeKey.value === HISTORY_TAB_KEY)

  function buildKey(threadId: string, artifact: ChatArtifact): string {
    // 优先用产物 ID：同一路径被覆盖重写时也能区分成不同版本
    const identity = artifact.artifact_id || artifact.path
    return (threadId || 'local') + '::' + identity
  }

  /** 打开（或激活）文档标签页，返回是否为本次新开 */
  function openDocument(artifact: ChatArtifact, threadId: string): boolean {
    const key = buildKey(threadId, artifact)
    const exists = tabs.value.some((tab) => tab.key === key)
    if (!exists) {
      tabs.value = [
        ...tabs.value,
        {
          key,
          path: artifact.path,
          name: artifact.name || artifact.path.split('/').pop() || '未命名文件',
          threadId,
          artifactId: artifact.artifact_id,
          status: artifact.status,
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
