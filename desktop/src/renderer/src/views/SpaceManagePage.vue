<script setup lang="ts">
import { useAgentStore } from '@renderer/store/agent'
import { useSpaceManage } from '@renderer/composables/useSpaceManage'
import SpaceListPanel from '../components/space/SpaceListPanel.vue'
import SpaceTaskPanel from '../components/space/SpaceTaskPanel.vue'
import SpaceRenameModal from '../components/space/SpaceRenameModal.vue'
import WorkspaceCreateModal from '../components/WorkspaceCreateModal.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'

/**
 * 空间管理页（入口：侧栏「空间」行 hover 的「管理」按钮）。
 *
 * 左列全部空间（新建/改名/删除/拖拽排序），右列选中空间的任务（改名/删除）。
 * 选中是页内浏览态，不会切换「新建任务」的工作空间落点（见 useSpaceManage 的约束说明）。
 */
const emit = defineEmits<{
  /** 返回来源页（由 Home 恢复进入前的页面） */
  back: []
  /** 打开某条任务：Home 负责切到「新建任务」页并回显该会话 */
  openTask: [id: string]
}>()

const agentStore = useAgentStore()

const {
  spaces,
  sortableSpaces,
  defaultSpace,
  currentId,
  selectedSpace,
  selectedTasks,
  taskCounts,
  selectSpace,
  createOpen,
  onCreated,
  renameTarget,
  renameTitle,
  renameLabel,
  renameCurrent,
  renameMaxlength,
  renameError,
  renaming,
  openRenameSpace,
  openRenameTask,
  closeRename,
  submitRename,
  deleteSpaceTarget,
  deleteSpaceMessage,
  openDeleteSpace,
  closeDeleteSpace,
  confirmDeleteSpace,
  deleteTaskTarget,
  openDeleteTask,
  closeDeleteTask,
  confirmDeleteTask,
  reorderError,
  reorder,
  openDir,
  openTask
} = useSpaceManage({
  onOpenTask: async (id) => {
    await agentStore.selectConversation(id)
    emit('openTask', id)
  }
})
</script>

<template>
  <div class="space-manage">
    <header class="sm-header">
      <button class="sm-back" type="button" @click="emit('back')">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        返回
      </button>
      <h2 class="sm-header-title">空间管理</h2>
      <span class="sm-header-sub">共 {{ spaces.length }} 个空间</span>
    </header>

    <div class="sm-workbench">
      <SpaceListPanel
        :spaces="sortableSpaces"
        :default-space="defaultSpace"
        :selected-id="selectedSpace?.id ?? ''"
        :current-id="currentId"
        :task-counts="taskCounts"
        @select="selectSpace"
        @rename="openRenameSpace"
        @delete="openDeleteSpace"
        @create="createOpen = true"
        @reorder="reorder"
      />
      <div class="sm-divider"></div>
      <SpaceTaskPanel
        :space="selectedSpace"
        :tasks="selectedTasks"
        @open-task="openTask"
        @rename-task="openRenameTask"
        @delete-task="openDeleteTask"
        @open-dir="openDir"
      />
    </div>

    <!-- 排序失败提示（服务端集合校验会拒绝陈旧列表；store 已回滚本地顺序） -->
    <p v-if="reorderError" class="sm-toast">{{ reorderError }}</p>

    <!-- 新建空间（复用输入卡的同一弹窗；defineModel 即 modelValue） -->
    <WorkspaceCreateModal v-model="createOpen" @created="onCreated" />

    <!-- 删除空间确认（文案含动态任务数） -->
    <ConfirmDialog
      v-if="deleteSpaceTarget"
      title="移除工作空间"
      :message="deleteSpaceMessage"
      @confirm="confirmDeleteSpace"
      @cancel="closeDeleteSpace"
    />

    <!-- 删除任务确认（与侧栏会话菜单同一串文案） -->
    <ConfirmDialog
      v-if="deleteTaskTarget"
      title="删除任务"
      message="确认从列表中删除任务吗？删除后对话记录无法恢复，请确认是否删除？"
      @confirm="confirmDeleteTask"
      @cancel="closeDeleteTask"
    />

    <!-- 改名弹窗（空间名 / 任务标题共用） -->
    <SpaceRenameModal
      :open="!!renameTarget"
      :title="renameTitle"
      :label="renameLabel"
      :current="renameCurrent"
      :maxlength="renameMaxlength"
      :error="renameError"
      :saving="renaming"
      @submit="submitRename"
      @close="closeRename"
    />
  </div>
</template>

<style scoped>
.space-manage {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--kw-color-surface);
  font-family: inherit;
}

.sm-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 24px 14px;
  border-bottom: 1px solid var(--kw-color-border-soft);
}

.sm-back {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px 5px 6px;
  border: 1px solid var(--kw-color-border);
  border-radius: 8px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sm-back:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.sm-header-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.sm-header-sub {
  font-size: 12px;
  color: var(--kw-color-text-subtle);
}

.sm-workbench {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px 16px 16px;
}

.sm-divider {
  width: 1px;
  margin: 4px 4px;
  background: var(--kw-color-border-soft);
}

.sm-toast {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  margin: 0;
  padding: 8px 16px;
  border-radius: 8px;
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger-strong);
  font-size: 12px;
}
</style>
