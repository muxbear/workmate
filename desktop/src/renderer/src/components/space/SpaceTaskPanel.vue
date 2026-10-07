<script setup lang="ts">
import { formatRelativeTime } from '@renderer/composables/formatTime'
import type { Conversation } from '@renderer/store/agent'
import type { Workspace } from '../../../../shared/contracts'

/**
 * 空间管理页右列：选中空间下的任务（会话）列表。
 *
 * 任务 = 会话；「编辑」= 重命名标题、「删除」= 删除会话（对话记录不可恢复），
 * 两条动作都直接复用侧栏会话菜单既有的 agentStore 管线。
 */
defineProps<{
  /** 当前选中的空间（无选中时为 null，右列渲染空态） */
  space: Workspace | null
  /** 该空间下的任务（已按更新时间降序） */
  tasks: Conversation[]
}>()

const emit = defineEmits<{
  openTask: [id: string]
  renameTask: [task: Conversation]
  deleteTask: [task: Conversation]
  openDir: [space: Workspace]
}>()
</script>

<template>
  <section class="sm-detail">
    <header v-if="space" class="sm-detail-head">
      <div class="sm-detail-title-wrap">
        <h3 class="sm-detail-title" :title="space.name">{{ space.name }}</h3>
        <span class="sm-detail-meta">
          {{ tasks.length }} 个任务 · {{ space.path }}
        </span>
      </div>
      <button class="sm-detail-open" type="button" @click="emit('openDir', space)">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        打开文件夹
      </button>
    </header>

    <div v-if="space" class="sm-task-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="sm-task"
        :data-task-id="task.id"
        @click="emit('openTask', task.id)"
      >
        <div class="sm-task-main">
          <p class="sm-task-title" :title="task.title">{{ task.title }}</p>
          <p class="sm-task-time">{{ formatRelativeTime(task.updateAt) }}</p>
        </div>
        <div class="sm-task-actions">
          <button
            class="sm-task-btn"
            type="button"
            title="重命名"
            @click.stop="emit('renameTask', task)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            class="sm-task-btn sm-task-btn--danger"
            type="button"
            title="删除任务"
            @click.stop="emit('deleteTask', task)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <p v-if="tasks.length === 0" class="sm-task-empty">该空间下暂无任务</p>
    </div>

    <p v-else class="sm-task-empty">请选择左侧的空间</p>
  </section>
</template>

<style scoped>
.sm-detail {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 16px 16px;
  overflow-y: auto;
}

.sm-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 4px 14px;
  border-bottom: 1px solid var(--kw-color-border-soft);
}

.sm-detail-title-wrap {
  min-width: 0;
}

.sm-detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--kw-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-detail-meta {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--kw-color-text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-detail-open {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 12px;
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

.sm-detail-open:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.sm-task-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
}

.sm-task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.sm-task:hover {
  background: var(--kw-color-bg-soft);
}

.sm-task-main {
  flex: 1 1 auto;
  min-width: 0;
}

.sm-task-title {
  margin: 0;
  font-size: 13px;
  color: var(--kw-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sm-task-time {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--kw-color-text-subtle);
}

.sm-task-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.15s ease,
    visibility 0.15s ease;
}

.sm-task:hover .sm-task-actions,
.sm-task:focus-within .sm-task-actions {
  opacity: 1;
  visibility: visible;
}

.sm-task-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--kw-color-text-muted);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sm-task-btn:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.sm-task-btn--danger:hover {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
}

.sm-task-empty {
  margin: 24px 4px;
  font-size: 12px;
  color: var(--kw-color-text-subtle);
}
</style>
