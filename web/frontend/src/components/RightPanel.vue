<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import { RIGHT_PANEL_COLLAPSED_WIDTH, useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import { useWorkspaceStore } from '@/stores/workspace'
import DocumentViewer from './chat/DocumentViewer.vue'

/** 右侧工作区：固定「历史对话」标签 + 可关闭的文档标签页 */
const uiStore = useUiStore()
const chatStore = useChatStore()
const workspaceStore = useWorkspaceStore()

const tabsViewportRef = ref<HTMLElement | null>(null)
const overflow = ref(false)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
/** 两个标签移动按钮占用的宽度（按钮 26px + 间距 4px） */
const ARROW_SPACE = 60

const panelWidth = computed(() =>
  uiStore.rightPanelCollapsed ? RIGHT_PANEL_COLLAPSED_WIDTH : uiStore.rightPanelWidth,
)
/** 右栏较窄时新建对话按钮只保留图标，给标签页留出空间 */
const compactBar = computed(() => panelWidth.value < 360)

let viewportObserver: ResizeObserver | null = null

/** 监听标签可视区尺寸：右栏拖拽 / 窗口缩放导致标签放不下时，及时出现移动按钮 */
function bindViewportObserver() {
  viewportObserver?.disconnect()
  viewportObserver = null
  const el = tabsViewportRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  viewportObserver = new ResizeObserver(() => syncOverflow())
  viewportObserver.observe(el)
}

onMounted(() => {
  uiStore.fetchHistories()
  window.addEventListener('resize', syncOverflow)
  bindViewportObserver()
  void nextTick(syncOverflow)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncOverflow)
  viewportObserver?.disconnect()
  viewportObserver = null
})

watch(
  () => workspaceStore.tabs.map((tab) => tab.key).join('|'),
  () => void nextTick(syncOverflow),
)
watch(
  () => workspaceStore.activeKey,
  () => void nextTick(scrollActiveTabIntoView),
)
watch(
  () => [uiStore.rightPanelWidth, uiStore.rightPanelCollapsed],
  () =>
    void nextTick(() => {
      bindViewportObserver()
      syncOverflow()
    }),
)

/** 标签页总宽度超出可视区域时出现左右移动按钮 */
function syncOverflow() {
  const el = tabsViewportRef.value
  if (!el) {
    overflow.value = false
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }
  // 移动按钮显示后本身会占用宽度，这里把它补回来判断，
  // 保证「放得下就隐藏、放不下才显示」不会因为按钮自身宽度来回抖动
  const available = el.clientWidth + (overflow.value ? ARROW_SPACE : 0)
  overflow.value = el.scrollWidth - available > 1
  const maxScroll = el.scrollWidth - el.clientWidth
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft < maxScroll - 1
}

function scrollTabs(direction: 1 | -1) {
  const el = tabsViewportRef.value
  if (!el) return
  el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' })
}

/** 激活的标签页滚动到可视区域 */
function scrollActiveTabIntoView() {
  const el = tabsViewportRef.value?.querySelector<HTMLElement>('.panel-tab.is-active')
  el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  syncOverflow()
}

async function handleSelectHistory(threadId: string) {
  uiStore.activeThreadId = threadId
  await chatStore.loadConversation(threadId)
}

/** 删除历史对话：二次确认（删除后消息与产物不可恢复） */
async function handleDeleteHistory(threadId: string, title: string) {
  const name = title ? '《' + title + '》' : '该对话'
  try {
    await ElMessageBox.confirm('删除' + name + '后，消息与产物将不可恢复，是否继续？', '删除对话', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      closeOnClickModal: false,
    })
  } catch {
    return
  }

  await uiStore.deleteHistory(threadId)
  const removed = !uiStore.histories.some((item) => item.thread_id === threadId)
  if (removed) {
    if (chatStore.threadId === threadId) {
      chatStore.clearMessages()
    }
    ElMessage.success('对话已删除')
  } else {
    ElMessage.error('删除失败，请稍后重试')
  }
}

function handleNewConversation() {
  chatStore.clearMessages()
  uiStore.newConversation()
  workspaceStore.closeAllTabs()
}
</script>

<template>
  <aside
    class="right-panel"
    :class="{ collapsed: uiStore.rightPanelCollapsed }"
    :style="{ width: panelWidth + 'px', minWidth: panelWidth + 'px' }"
  >
    <!-- 收起态：仅保留展开按钮 -->
    <div v-if="uiStore.rightPanelCollapsed" class="panel-collapsed">
      <button class="expand-btn" title="展开右栏" @click="uiStore.toggleRightPanel">
        <PanelRightOpen :size="14" />
      </button>
    </div>

    <div v-else class="panel-expanded">
      <div class="panel-bar">
        <!-- 收起按钮：位于「历史对话」标签页左侧 -->
        <button class="collapse-btn" title="收起右栏" @click="uiStore.toggleRightPanel">
          <PanelRightClose :size="14" />
        </button>

        <div ref="tabsViewportRef" class="tabs-viewport" @scroll="syncOverflow">
          <div class="tabs-track">
            <button
              class="panel-tab panel-tab--fixed"
              :class="{ 'is-active': workspaceStore.historyActive }"
              @click="workspaceStore.activateHistory()"
            >
              历史对话
            </button>
            <button
              v-for="tab in workspaceStore.tabs"
              :key="tab.key"
              class="panel-tab panel-tab--document"
              :class="{ 'is-active': workspaceStore.activeKey === tab.key }"
              :title="tab.path"
              @click="workspaceStore.activateTab(tab.key)"
            >
              <span class="tab-label">{{ tab.name }}</span>
              <span
                class="tab-close"
                title="关闭标签页"
                @click.stop="workspaceStore.closeTab(tab.key)"
              >
                <X :size="12" />
              </span>
            </button>
          </div>
        </div>

        <button
          v-if="overflow"
          class="tab-scroll"
          title="标签页向左移动"
          :disabled="!canScrollLeft"
          @click="scrollTabs(-1)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          v-if="overflow"
          class="tab-scroll"
          title="标签页向右移动"
          :disabled="!canScrollRight"
          @click="scrollTabs(1)"
        >
          <ChevronRight :size="14" />
        </button>

        <button class="new-chat-btn" title="新建对话" @click="handleNewConversation">
          <Plus :size="14" />
          <span v-if="!compactBar">新建对话</span>
        </button>
      </div>

      <div class="panel-body">
        <div v-if="workspaceStore.historyActive" class="history-list">
          <div
            v-for="item in uiStore.histories"
            :key="item.thread_id"
            class="history-item"
            :class="{ active: uiStore.activeThreadId === item.thread_id }"
            @click="handleSelectHistory(item.thread_id)"
          >
            <span class="history-title">{{ item.title }}</span>
            <button
              class="delete-btn"
              @click.stop="handleDeleteHistory(item.thread_id, item.title)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <DocumentViewer
          v-else-if="workspaceStore.activeTab"
          :key="workspaceStore.activeTab.key"
          :tab="workspaceStore.activeTab"
        />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.right-panel {
  height: 100%;
  background: var(--surface-card);
  border-left: 1px solid var(--border-subtle);
  overflow: hidden;
  transition:
    width var(--transition-duration) ease,
    min-width var(--transition-duration) ease;
}

.panel-expanded {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  height: 100%;
  min-height: 0;
}

.panel-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.collapse-btn,
.tab-scroll {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.collapse-btn:hover,
.tab-scroll:hover:not(:disabled) {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.tab-scroll:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tabs-viewport {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.tabs-viewport::-webkit-scrollbar {
  display: none;
}

.tabs-track {
  display: flex;
  align-items: center;
  gap: 4px;
  /* 宽度收束到可视区域：标签先按比例收窄，确实放不下时再出现左右移动按钮 */
  width: 100%;
  min-width: 0;
}

.panel-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 68px;
  max-width: 160px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  cursor: pointer;
}

.panel-tab:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.panel-tab.is-active {
  background: var(--accent-primary-light);
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

/* 「历史对话」固定标签不参与收窄 */
.panel-tab--fixed {
  flex: 0 0 auto;
  min-width: 0;
}

.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  color: inherit;
  opacity: 0.6;
}

.tab-close:hover {
  background: var(--surface-secondary);
  opacity: 1;
}

.new-chat-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--radius-lg);
  border: none;
  background: var(--accent-primary);
  color: white;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.new-chat-btn:hover {
  opacity: 0.85;
}

.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  cursor: pointer;
  transition: background 0.15s ease;
}

.history-item.active,
.history-item:hover,
.history-item.active:hover {
  background: var(--accent-primary-light);
}

.history-title {
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-item.active .history-title {
  color: var(--foreground-primary);
}

.delete-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
  flex: 0 0 auto;
}

.history-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.panel-collapsed {
  height: 100%;
  position: relative;
}

.expand-btn {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--surface-secondary);
  color: var(--foreground-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.expand-btn:hover {
  background: var(--border-subtle);
}
</style>
