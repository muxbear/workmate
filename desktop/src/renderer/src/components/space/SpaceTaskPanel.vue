<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import { formatRelativeTime } from '@renderer/composables/formatTime'
import { usePagination } from '@renderer/composables/usePagination'
import type { Conversation } from '@renderer/store/agent'
import type { Workspace } from '../../../../shared/contracts'

/**
 * 空间管理页右列：选中空间下的任务（会话）列表 + 分页。
 *
 * 任务 = 会话；「编辑」= 重命名标题、「删除」= 删除会话（对话记录不可恢复），
 * 两条动作都直接复用侧栏会话菜单既有的 agentStore 管线。
 *
 * 分页是纯视图能力（整份列表已在内存）：切换空间回到第 1 页，删条目导致页码越界时自动回落。
 */
const props = defineProps<{
  /** 当前选中的空间（无选中时为 null，右列渲染空态） */
  space: Workspace | null
  /** 该空间下的任务（已按更新时间降序，未分页） */
  tasks: Conversation[]
}>()

const emit = defineEmits<{
  openTask: [id: string]
  renameTask: [task: Conversation]
  deleteTask: [task: Conversation]
  openDir: [space: Workspace]
}>()

/** 每页条数本地持久化键（刷新/重启沿用上次选择） */
const PAGE_SIZE_KEY = 'ke-work.space-manage.page-size'

const { page, pageSize, sizes, total, pageCount, pageItems, setPage, prev, next, setPageSize, reset } =
  usePagination<Conversation>(toRef(props, 'tasks'), { storageKey: PAGE_SIZE_KEY })

// 切换空间 → 回到第 1 页（与"删条目越界回落"是两种语义，分开处理）
watch(
  () => props.space?.id,
  () => reset()
)

/** 翻页后把列表滚回顶部（否则停在上一页的滚动位置，看不到本页首条） */
const listRef = ref<HTMLElement | null>(null)
watch(page, () => {
  if (listRef.value) listRef.value.scrollTop = 0
})

// ── 跳页输入 ──
const jumpText = ref('')

function doJump(): void {
  const target = Number.parseInt(jumpText.value, 10)
  if (Number.isInteger(target)) setPage(target)
  jumpText.value = ''
}

/** 每页条数下拉：value 来自原生 select，需转回数字 */
function onSizeChange(event: Event): void {
  setPageSize(Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <section class="sm-detail">
    <header v-if="space" class="sm-detail-head">
      <div class="sm-detail-title-wrap">
        <h3 class="sm-detail-title" :title="space.name">{{ space.name }}</h3>
        <span class="sm-detail-meta"> {{ total }} 个任务 · {{ space.path }} </span>
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

    <template v-if="space">
      <div ref="listRef" class="sm-task-list">
        <div
          v-for="task in pageItems"
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

        <p v-if="total === 0" class="sm-task-empty">该空间下暂无任务</p>
      </div>

      <!-- 分页条：总条数 / 翻页 / 跳页 / 每页条数 -->
      <div v-if="total > 0" class="sm-pager">
        <span class="sm-pager-total">共 {{ total }} 条</span>
        <div class="sm-pager-nav">
          <button
            class="sm-pager-btn"
            type="button"
            :disabled="page <= 1"
            @click="prev"
          >
            上一页
          </button>
          <span class="sm-pager-indicator">第 {{ page }} / {{ pageCount }} 页</span>
          <button
            class="sm-pager-btn"
            type="button"
            :disabled="page >= pageCount"
            @click="next"
          >
            下一页
          </button>
        </div>
        <label class="sm-pager-jump">
          跳至
          <input
            v-model="jumpText"
            class="sm-pager-input"
            type="text"
            inputmode="numeric"
            :placeholder="String(page)"
            @keydown.enter.prevent="doJump"
          />
          页
          <button class="sm-pager-btn sm-pager-btn--go" type="button" @click="doJump">跳转</button>
        </label>
        <label class="sm-pager-size">
          每页
          <select class="sm-pager-select" :value="String(pageSize)" @change="onSizeChange">
            <option v-for="size in sizes" :key="size" :value="String(size)">{{ size }} 条</option>
          </select>
        </label>
      </div>
    </template>

    <p v-else class="sm-task-empty">请选择左侧的空间</p>
  </section>
</template>

<style scoped>
.sm-detail {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 4px 16px 12px;
  overflow: hidden;
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

/* 列表区：唯一滚动容器（分页条固定在底部） */
.sm-task-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
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

/* ── 分页条 ── */
.sm-pager {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  flex-shrink: 0;
  padding: 10px 4px 2px;
  border-top: 1px solid var(--kw-color-border-soft);
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.sm-pager-total {
  color: var(--kw-color-text-secondary);
}

.sm-pager-nav {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sm-pager-indicator {
  min-width: 76px;
  text-align: center;
  color: var(--kw-color-text-secondary);
}

.sm-pager-btn {
  padding: 4px 10px;
  border: 1px solid var(--kw-color-border);
  border-radius: 6px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    opacity 0.15s ease;
}

.sm-pager-btn:hover:not(:disabled) {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.sm-pager-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sm-pager-jump,
.sm-pager-size {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sm-pager-input {
  width: 46px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--kw-color-border);
  border-radius: 6px;
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
  font-size: 12px;
  font-family: inherit;
  text-align: center;
  outline: none;
}

.sm-pager-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.sm-pager-select {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--kw-color-border);
  border-radius: 6px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
}
</style>
