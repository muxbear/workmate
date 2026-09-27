<script setup lang="ts">
/**
 * 右栏栏目视图——某个分组的全量知识库（可检索、可翻页、可切卡片/列表、可拖动排序）。
 *
 * 由左栏分组名或「查看更多」进入。分页：能走服务端分页的走服务端（`page` 参数）；
 * 「共享给我的」「我的共享」这两类在客户端过滤，就在本地切页——否则一个栏目攒到
 * 几十个库就只能从头滚到尾。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Database, LayoutGrid, List, Search } from 'lucide-vue-next'
import { useKnowledgeBaseStore, KB_GROUPS } from '@/stores/knowledgeBase'
import type { KB, KbScope, ViewMode } from '@/types/knowledgeBase'
import { KB_STATUS_CONFIG } from '@/types/knowledgeBase'
import { readApiError } from '@/services/knowledgeBaseApi'
import { useCardDragSort } from '@/composables/useCardDragSort'
import KbCard from './KbCard.vue'

const props = defineProps<{ scope: Exclude<KbScope, 'overview'> }>()

const store = useKnowledgeBaseStore()
const { t } = useI18n()
const keyword = ref('')
const page = ref(1)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const groupLabel = computed(
  () => KB_GROUPS.find((g) => g.id === props.scope)?.label || '',
)

const state = computed(() => store.groups[props.scope])
const pageSize = computed(() => state.value?.pageSize || 12)

/** 「共享给我的」与「我的共享」在客户端过滤，分页只能在本地做 */
const clientFiltered = computed(() => props.scope === 'sharedWithMe' || props.scope === 'sharedByMe')

const visibleItems = computed(() => {
  const items = state.value?.items || []
  const q = keyword.value.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (kb) =>
      kb.name.toLowerCase().includes(q) ||
      kb.description.toLowerCase().includes(q) ||
      kb.tags.some((t) => t.toLowerCase().includes(q)),
  )
})

/** 当前页要显示的数据：服务端分页的栏目取回来就是一页，客户端过滤的在这里切 */
const pagedItems = computed(() => {
  if (!clientFiltered.value) return visibleItems.value
  const start = (page.value - 1) * pageSize.value
  return visibleItems.value.slice(start, start + pageSize.value)
})

const pagerTotal = computed(() =>
  clientFiltered.value ? visibleItems.value.length : state.value?.total || 0,
)

function reload(target = 1) {
  page.value = target
  if (clientFiltered.value) return
  void store.loadGroup(props.scope, target)
}

watch(() => props.scope, () => {
  keyword.value = ''
  reload(1)
})

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => reload(1), 300)
}

// 防抖定时器要跟着组件一起走：不清理的话，切走页面后它还会再打一次请求
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/** 视图偏好跟着 store：概览页与这里表达的是同一件事——"我喜欢怎么看知识库" */
const viewMode = computed(() => store.viewMode)

function setViewMode(mode: ViewMode) {
  store.viewMode = mode
}

function openKb(id: string) {
  void store.selectKb(id)
}

/**
 * 拖动排序只在「个人知识库」页、且没在检索时开放：
 *
 * - 顺序是**本人的列表视图偏好**，后端只在 scope=personal 时按它排（公共库 / 共享
 *   给我的按更新时间排），在别的栏目里拖出来的顺序刷新就没了；
 * - 检索后屏幕上的"相邻"不等于列表里的"相邻"，拖着排会连带改掉中间没显示的库。
 */
const sortable = computed(
  () => props.scope === 'personal' && !keyword.value.trim() && !state.value?.loading,
)

const {
  draggingId,
  items: orderedItems,
  onCardPointerDown,
  handleClick,
} = useCardDragSort<KB>({
  items: () => pagedItems.value,
  idOf: (kb) => kb.id,
  blockOf: (kb) => (kb.isPinned ? 'pinned' : 'plain'),
  enabled: () => sortable.value,
  onReorder: async (ids) => {
    try {
      await store.reorderKbs(ids)
    } catch (err: unknown) {
      ElMessage.error(t('knowledge.card.reorderFailed', { reason: readApiError(err) }))
    }
  },
})
</script>

<template>
  <div class="kb-group-panel">
    <div class="panel-toolbar">
      <div class="search-wrap">
        <Search :size="16" class="search-icon" />
        <input
          v-model="keyword"
          type="text"
          :placeholder="`在「${groupLabel}」中检索…`"
          class="search-input"
          @input="onSearchInput"
        />
      </div>
      <span class="panel-count">共 {{ pagerTotal }} 个</span>
      <span v-if="sortable" class="panel-hint">{{ t('knowledge.card.dragHint') }}</span>
      <div class="view-toggle">
        <button
          :class="['view-btn', { active: viewMode === 'grid' }]"
          @click="setViewMode('grid')"
        >
          <LayoutGrid :size="14" />{{ t('knowledge.list.viewCard') }}
        </button>
        <button
          :class="['view-btn', { active: viewMode === 'list' }]"
          @click="setViewMode('list')"
        >
          <List :size="14" />{{ t('knowledge.list.viewList') }}
        </button>
      </div>
    </div>

    <div v-loading="state?.loading" class="panel-body">
      <!-- 卡片视图 -->
      <div
        v-if="pagedItems.length && viewMode === 'grid'"
        data-sort-area
        class="kb-grid"
        :class="{ 'kb-grid--sortable': sortable, 'kb-grid--dragging': !!draggingId }"
      >
        <KbCard
          v-for="kb in orderedItems()"
          :key="kb.id"
          :data-card-id="kb.id"
          :class="{ 'kb-card--dragging': draggingId === kb.id }"
          :kb="kb"
          @pointerdown="onCardPointerDown($event, kb.id)"
          @click="handleClick(() => openKb(kb.id))"
        />
      </div>

      <!-- 列表视图（用 div 排的表格：<tr> 上的 transform 各浏览器行为不一，拖动会飘） -->
      <div
        v-else-if="pagedItems.length"
        data-sort-area
        class="kb-list"
        :class="{ 'kb-grid--sortable': sortable, 'kb-grid--dragging': !!draggingId }"
      >
        <div class="kb-list-head">
          <span class="col-name">{{ t('knowledge.list.colName') }}</span>
          <span class="col-status">{{ t('knowledge.list.colStatus') }}</span>
          <span class="col-num">{{ t('knowledge.list.colDocs') }}</span>
          <span class="col-num">{{ t('knowledge.list.colChunks') }}</span>
          <span class="col-size">{{ t('knowledge.list.colSize') }}</span>
          <span class="col-date">{{ t('knowledge.list.colUpdated') }}</span>
        </div>
        <div
          v-for="kb in orderedItems()"
          :key="kb.id"
          :data-card-id="kb.id"
          class="kb-list-row"
          :class="{ 'kb-card--dragging': draggingId === kb.id }"
          role="button"
          tabindex="0"
          @pointerdown="onCardPointerDown($event, kb.id)"
          @click="handleClick(() => openKb(kb.id))"
          @keydown.enter="openKb(kb.id)"
        >
          <span class="col-name">
            <span class="kb-list-icon"><Database :size="14" /></span>
            <span class="kb-list-text">
              <span class="kb-list-name">{{ kb.name }}</span>
              <span class="kb-list-desc">{{ kb.description }}</span>
            </span>
          </span>
          <span class="col-status">
            <el-tag :class="['status-tag', KB_STATUS_CONFIG[kb.status].cls]" size="small" disable-transitions>
              {{ KB_STATUS_CONFIG[kb.status].label }}
            </el-tag>
          </span>
          <span class="col-num">{{ kb.docs }}</span>
          <span class="col-num">{{ kb.chunks.toLocaleString() }}</span>
          <span class="col-size">{{ kb.size }}</span>
          <span class="col-date">{{ kb.updatedAt }}</span>
        </div>
      </div>

      <el-empty v-else-if="!state?.loading" description="暂无知识库" />

      <div v-if="pagerTotal > pageSize" class="panel-pager">
        <el-pagination
          layout="prev, pager, next"
          background
          :current-page="page"
          :page-size="pageSize"
          :total="pagerTotal"
          @current-change="reload"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.kb-group-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search-wrap {
  position: relative;
  flex: 1;
  min-width: 180px;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-secondary);
  pointer-events: none;
  z-index: 1;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.search-input::placeholder {
  color: var(--foreground-muted);
}

.search-input:focus {
  border-color: rgba(59, 130, 246, 0.4);
}

.panel-count {
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.panel-hint {
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.view-toggle {
  display: flex;
  align-items: center;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 2px;
}

.view-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  border: 1px solid transparent;
  background: none;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.view-btn.active {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(139, 92, 246, 0.3));
  color: var(--foreground-primary);
  border-color: rgba(59, 130, 246, 0.3);
}

.view-btn:hover:not(.active) {
  color: var(--foreground-primary);
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.kb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

/* ── 列表视图 ── */
.kb-list {
  display: flex;
  flex-direction: column;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.kb-list-head,
.kb-list-row {
  display: grid;
  grid-template-columns: minmax(200px, 2fr) 90px 60px 80px 80px 100px;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}

.kb-list-head {
  background: var(--surface-secondary);
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-secondary);
}

.kb-list-row {
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background 0.15s;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.kb-list-row:last-child {
  border-bottom: none;
}

.kb-list-row:hover {
  background: var(--surface-secondary);
}

.col-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.kb-list-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(139, 92, 246, 0.2));
  border: 1px solid rgba(59, 130, 246, 0.3);
  color: #93c5fd;
}

.kb-list-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.kb-list-name,
.kb-list-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-list-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.col-num,
.col-size,
.col-date {
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.status-tag {
  display: inline-flex;
  align-items: center;
}

.status-ready {
  background: rgba(16, 185, 129, 0.15);
  color: #6ee7b7;
  border-color: rgba(16, 185, 129, 0.3);
}

.status-indexing {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
  border-color: rgba(59, 130, 246, 0.3);
}

.status-error {
  background: rgba(244, 63, 94, 0.15);
  color: #fda4af;
  border-color: rgba(244, 63, 94, 0.3);
}

.status-draft {
  background: rgba(100, 116, 139, 0.15);
  color: #94a3b8;
  border-color: rgba(100, 116, 139, 0.3);
}

/* 可拖动时的抓手光标：不给提示的话没人会去长按卡片 */
.kb-grid--sortable .kb-card,
.kb-grid--sortable .kb-list-row {
  cursor: grab;
}

.kb-grid--dragging .kb-card,
.kb-grid--dragging .kb-list-row {
  /* 拖动期间关掉过渡：卡片要跟手，动画会让它慢半拍 */
  transition: none;
  user-select: none;
}

.kb-card--dragging {
  cursor: grabbing;
  opacity: 0.9;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.3);
}

.panel-pager {
  display: flex;
  justify-content: center;
  padding: 18px 0 4px;
}

/*
 * 窄屏（<768）：六列的列表放不下，让容器自己横向滚动，列不至于挤成一团。
 * 与概览页的表格同一套做法（那边是 10 列，这里 6 列）。
 */
@media (max-width: 767px) {
  .kb-list {
    overflow-x: auto;
  }

  .kb-list-head,
  .kb-list-row {
    min-width: 640px;
  }
}
</style>
