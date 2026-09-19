<script setup lang="ts">
import { ChevronDown, PanelRightClose, PanelRightOpen, Plus, Trash2 } from 'lucide-vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUiStore } from '@/stores/ui'
import { useChatStore } from '@/stores/chat'
import ArtifactPanel from './chat/ArtifactPanel.vue'
import { formatFileSize } from '@/utils/format'
import { onMounted } from 'vue'

const uiStore = useUiStore()
const chatStore = useChatStore()

onMounted(() => {
  uiStore.fetchHistories()
})

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
}
</script>

<template>
  <aside class="right-panel" :class="{ collapsed: uiStore.rightPanelCollapsed }">
    <div v-if="!uiStore.rightPanelCollapsed" class="panel-expanded">
      <div class="panel-tabs">
        <button
          class="panel-tab"
          :class="{ active: uiStore.rightPanelTab === 'history' }"
          @click="uiStore.rightPanelTab = 'history'"
        >
          历史对话
        </button>
        <button
          class="panel-tab"
          :class="{ active: uiStore.rightPanelTab === 'artifacts' }"
          @click="uiStore.rightPanelTab = 'artifacts'"
        >
          会话产物 ({{ chatStore.threadArtifacts.length }})
        </button>
      </div>

      <div class="panel-header">
        <div class="panel-header-left">
          <span class="panel-title">历史对话</span>
          <ChevronDown :size="14" class="toggle-icon" />
        </div>
        <div class="panel-header-right">
          <button class="collapse-btn" @click="uiStore.toggleRightPanel">
            <PanelRightClose :size="14" />
          </button>
          <button class="new-chat-btn" @click="handleNewConversation">
            <Plus :size="14" />
            <span>新建对话</span>
          </button>
        </div>
      </div>

      <div v-if="uiStore.rightPanelTab === 'history'" class="history-list">
        <div
          v-for="item in uiStore.histories"
          :key="item.thread_id"
          class="history-item"
          :class="{ active: uiStore.activeThreadId === item.thread_id }"
          @click="handleSelectHistory(item.thread_id)"
        >
          <span class="history-title">{{ item.title }}</span>
          <button class="delete-btn" @click.stop="handleDeleteHistory(item.thread_id, item.title)">
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="uiStore.rightPanelTab === 'artifacts'" class="artifact-view">
      <div class="artifact-items">
        <button
          v-for="item in chatStore.threadArtifacts"
          :key="item.path"
          class="artifact-item"
          :class="{ active: chatStore.previewArtifact?.path === item.path }"
          :title="item.path"
          @click="chatStore.openArtifact(item)"
        >
          <span class="artifact-item-name">{{ item.name }}</span>
          <span v-if="formatFileSize(item.size)" class="artifact-item-size">{{
            formatFileSize(item.size)
          }}</span>
        </button>
        <p v-if="chatStore.threadArtifacts.length === 0" class="artifact-tip">
          本次会话暂无产物文件
        </p>
      </div>
      <ArtifactPanel v-if="chatStore.previewArtifact" />
    </div>
    <div v-else class="panel-collapsed">
      <button class="expand-btn" @click="uiStore.toggleRightPanel">
        <PanelRightOpen :size="14" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.right-panel {
  height: 100%;
  background: var(--surface-card);
  transition:
    width var(--transition-duration) ease,
    min-width var(--transition-duration) ease;
  overflow: hidden;
}

.right-panel:not(.collapsed) {
  width: var(--right-panel-width);
  min-width: var(--right-panel-width);
  border-left: 1px solid var(--border-subtle);
}

.right-panel.collapsed {
  width: var(--right-panel-collapsed-width);
  min-width: var(--right-panel-collapsed-width);
  border-left: 1px solid var(--border-subtle);
}

.panel-expanded {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 12px;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-header-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.panel-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.toggle-icon {
  color: var(--foreground-muted);
  cursor: pointer;
}

.panel-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.collapse-btn {
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
}

.collapse-btn:hover {
  background: var(--surface-secondary);
}

.new-chat-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
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

.history-item.active {
  background: var(--accent-primary-light);
}

.history-item:hover {
  background: var(--accent-primary-light);
}

.history-item.active:hover {
  background: var(--accent-primary-light);
}

.history-title {
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
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
  width: 28px;
  height: 28px;
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

.panel-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.panel-tab {
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.panel-tab:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.panel-tab.active {
  background: var(--accent-primary-light);
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

.artifact-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.artifact-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 40%;
  overflow-y: auto;
}

.artifact-item {
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.artifact-item:hover,
.artifact-item.active {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.artifact-tip {
  margin: 0;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.artifact-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artifact-item-size {
  color: var(--foreground-muted);
  font-size: 10px;
  flex-shrink: 0;
}
</style>
