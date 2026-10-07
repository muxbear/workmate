<script setup lang="ts">
import { ref } from 'vue'
import { moveSpace } from './spaceList'
import type { Workspace } from '../../../../shared/contracts'

/**
 * 空间管理页左列：全部空间列表（新建 / 选中 / 改名 / 删除 / 拖拽排序）。
 *
 * - 默认空间单独渲染成只读行，且**不在可排序数组内** → 索引计算天然不需要夹取逻辑，也拖不动它
 * - 拖拽用原生 HTML5 DnD（与 KbMoreList 同范式；项目未引入任何拖拽库）
 * - 选中态（selectedId）是页内浏览态，由父级持有；currentId 只是「当前工作空间」微标
 */
const props = defineProps<{
  /** 可排序空间（非默认空间），顺序即展示顺序 */
  spaces: Workspace[]
  /** 默认空间（只读置顶；无默认空间记录时为 null） */
  defaultSpace: Workspace | null
  /** 页内选中 */
  selectedId: string
  /** 当前工作空间 id（新建任务的落点；仅做微标，点击行不会改变它） */
  currentId: string | null
  /** 各空间任务数（spaceId → 数量） */
  taskCounts: Map<string, number>
}>()

const emit = defineEmits<{
  select: [id: string]
  rename: [space: Workspace]
  delete: [space: Workspace]
  create: []
  reorder: [orderedIds: string[]]
}>()

// ── 拖拽排序状态机（镜像 useKbGroups 的 dragging/dropTarget/dropAfter 三态）──
const draggingId = ref('')
const dropTargetId = ref('')
const dropAfter = ref(false)

function resetDrag(): void {
  draggingId.value = ''
  dropTargetId.value = ''
  dropAfter.value = false
}

function onDragStart(space: Workspace, event: DragEvent): void {
  draggingId.value = space.id
  dropTargetId.value = ''
  dropAfter.value = false
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // 不写数据时部分平台会直接取消拖拽，写入 id 兜底
    event.dataTransfer.setData('text/plain', space.id)
  }
}

/** 悬停判定落点：列表按上下半区 */
function onDragOver(space: Workspace, event: DragEvent): void {
  if (!draggingId.value || space.id === draggingId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropTargetId.value = space.id
  dropAfter.value = event.clientY - rect.top > rect.height / 2
}

/** 落下：把可视顺序换算成新顺序并上报（拖拽项被摘除后，其后面的下标整体前移一位） */
function onDrop(): void {
  const source = draggingId.value
  const target = dropTargetId.value
  const after = dropAfter.value
  resetDrag()
  if (!source || !target || source === target) return
  const items = props.spaces
  const from = items.findIndex((item) => item.id === source)
  const targetIndex = items.findIndex((item) => item.id === target)
  if (from < 0 || targetIndex < 0) return
  let to = after ? targetIndex + 1 : targetIndex
  if (from < to) to -= 1
  const next = moveSpace(items, from, to)
  if (next === items) return
  emit(
    'reorder',
    next.map((item) => item.id)
  )
}

function countOf(id: string): number {
  return props.taskCounts.get(id) ?? 0
}
</script>

<template>
  <aside class="sm-list">
    <div class="sm-list-head">
      <span class="sm-list-title">全部空间</span>
      <button class="sm-list-add" type="button" title="新建空间" @click="emit('create')">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>

    <!-- 默认空间：只读置顶（不可拖、无改名/删除按钮；目录由系统设置管理） -->
    <div
      v-if="defaultSpace"
      class="space-row space-row--default"
      :class="{ 'space-row--active': defaultSpace.id === selectedId }"
      :data-space-id="defaultSpace.id"
      @click="emit('select', defaultSpace.id)"
    >
      <svg
        class="space-row-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </svg>
      <span class="space-row-name" :title="defaultSpace.name">{{ defaultSpace.name }}</span>
      <span class="space-row-tag">只读</span>
      <span class="space-row-count">{{ countOf(defaultSpace.id) }}</span>
    </div>

    <div class="space-row-list">
      <div
        v-for="space in spaces"
        :key="space.id"
        class="space-row"
        :class="{
          'space-row--active': space.id === selectedId,
          'space-row--current': space.id === currentId,
          'space-row--dragging': draggingId === space.id,
          'space-row--drop-before': dropTargetId === space.id && !dropAfter,
          'space-row--drop-after': dropTargetId === space.id && dropAfter
        }"
        :data-space-id="space.id"
        draggable="true"
        @click="emit('select', space.id)"
        @dragstart="onDragStart(space, $event)"
        @dragover="onDragOver(space, $event)"
        @drop.prevent="onDrop"
        @dragend="resetDrag"
      >
        <svg
          class="space-row-grip"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="9" cy="6" r="1" />
          <circle cx="15" cy="6" r="1" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="15" cy="12" r="1" />
          <circle cx="9" cy="18" r="1" />
          <circle cx="15" cy="18" r="1" />
        </svg>
        <span class="space-row-name" :title="space.name">{{ space.name }}</span>
        <span v-if="space.id === currentId" class="space-row-current" title="当前工作空间"></span>
        <span class="space-row-count">{{ countOf(space.id) }}</span>
        <span class="space-row-actions">
          <button
            class="space-row-btn"
            type="button"
            title="重命名"
            @click.stop="emit('rename', space)"
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
            class="space-row-btn space-row-btn--danger"
            type="button"
            title="删除"
            @click.stop="emit('delete', space)"
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
        </span>
      </div>

      <p v-if="spaces.length === 0" class="sm-list-empty">还没有可管理的空间，点右上角 ＋ 新建</p>
    </div>
  </aside>
</template>

<style scoped>
.sm-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 240px;
  flex-shrink: 0;
  padding: 4px 8px 12px;
  overflow-y: auto;
}

.sm-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
}

.sm-list-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text-muted);
}

.sm-list-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--kw-color-text-muted);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sm-list-add:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.space-row-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.space-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.space-row:hover {
  background: var(--kw-color-bg-soft);
}

.space-row--active {
  background: var(--kw-color-brand-soft);
  border-color: var(--kw-color-border-brand);
}

.space-row--default {
  cursor: default;
  margin-bottom: 2px;
}

.space-row--dragging {
  opacity: 0.45;
}

/* 落点提示：上半区插到目标之前、下半区插到目标之后 */
.space-row--drop-before::before,
.space-row--drop-after::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 1px;
  background: var(--kw-color-brand);
}

.space-row--drop-before::before {
  top: -2px;
}

.space-row--drop-after::after {
  bottom: -2px;
}

.space-row-icon,
.space-row-grip {
  flex-shrink: 0;
  color: var(--kw-color-text-subtle);
}

.space-row-grip {
  cursor: grab;
}

.space-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--kw-color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.space-row--default .space-row-name {
  color: var(--kw-color-text-secondary);
}

.space-row-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--kw-color-bg-muted);
  font-size: 10px;
  color: var(--kw-color-text-subtle);
}

.space-row-count {
  flex-shrink: 0;
  min-width: 16px;
  text-align: right;
  font-size: 11px;
  color: var(--kw-color-text-subtle);
}

/* 当前工作空间微标（与页内选中态区分：这个是"新建任务落点"） */
.space-row-current {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kw-color-brand);
}

.space-row-actions {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.15s ease,
    visibility 0.15s ease;
}

.space-row:hover .space-row-actions,
.space-row:focus-within .space-row-actions {
  opacity: 1;
  visibility: visible;
}

/* 操作按钮浮在计数之上，避免 hover 时视觉重叠 */
.space-row:hover .space-row-count {
  visibility: hidden;
}

.space-row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-muted);
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.space-row-btn:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.space-row-btn--danger:hover {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
}

.sm-list-empty {
  margin: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--kw-color-text-subtle);
}
</style>
