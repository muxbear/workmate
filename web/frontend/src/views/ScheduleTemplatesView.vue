<script setup lang="ts">
/**
 * 定时模板页面（「控制」目录下，紧跟「定时任务」）
 *
 * 模板是定时任务的一份完整预设：这里负责模板本身的增删改查，
 * 支持卡片 / 表格两种浏览形态、分页、关键词搜索与按类型筛选。
 * 类型取值来自「参数配置」的 schedule_template_type 分组。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, LayoutGrid, List, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-vue-next'
import ScheduleTemplateDialog from '@/components/automation/ScheduleTemplateDialog.vue'
import { useScheduleTemplateStore } from '@/stores/scheduleTemplate'
import { PAGINATION_LAYOUT, PAGE_SIZE_OPTIONS } from '@/types/pagination'
import type { ScheduleTemplate } from '@/types/scheduleTemplate'

const store = useScheduleTemplateStore()

const refreshing = ref(false)
const showDialog = ref(false)
const editingTemplate = ref<ScheduleTemplate | null>(null)

/** 当前筛选的类型名（卡片与表格里展示中文名而不是编码） */
function typeLabel(value: string): string {
  if (!value) return '未分类'
  return store.types.find((item) => item.value === value)?.label ?? value
}

const isEmpty = computed(() => !store.loading && store.templates.length === 0)

const emptyText = computed(() => {
  if (store.keyword || store.categoryFilter) return '没有符合条件的模板'
  return '暂无定时模板，点击右上角「新建模板」创建第一个'
})

/** 更新时间：今天 12:30 / 9月28日 12:30 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  const date = new Date(ts)
  const now = new Date()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`
}

async function loadAll(): Promise<void> {
  await Promise.all([store.loadTypes(), store.loadTemplates(), store.loadAddedState()])
}

/** 用模板生成一个定时任务（添加到「定时任务」页） */
async function handleAddToTasks(template: ScheduleTemplate): Promise<void> {
  if (store.addedTemplateIds.has(template.id)) return
  try {
    await store.addToTasks(template)
    ElMessage.success(`已添加「${template.name}」，可在「定时任务」中查看`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '添加失败')
  }
}

async function handleRefresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await loadAll()
  } finally {
    setTimeout(() => (refreshing.value = false), 400)
  }
}

async function handleCategoryChange(value: string): Promise<void> {
  store.categoryFilter = value
  store.resetPage()
  await store.loadTemplates()
}

async function handleKeywordChange(): Promise<void> {
  store.resetPage()
  await store.loadTemplates()
}

async function handlePageChange(page: number): Promise<void> {
  store.page = page
  await store.loadTemplates()
}

async function handlePageSizeChange(size: number): Promise<void> {
  store.pageSize = size
  store.resetPage()
  await store.loadTemplates()
}

function openCreate(): void {
  editingTemplate.value = null
  showDialog.value = true
}

function openEdit(template: ScheduleTemplate): void {
  editingTemplate.value = template
  showDialog.value = true
}

function closeDialog(): void {
  showDialog.value = false
  editingTemplate.value = null
}

async function handleSaved(): Promise<void> {
  const wasEditing = editingTemplate.value !== null
  closeDialog()
  // 新建后总数变化，回到第一页才能看到新模板（编辑时保持当前页）
  if (!wasEditing) store.resetPage()
  await store.loadTemplates()
}

async function handleDelete(template: ScheduleTemplate): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定要删除模板「${template.name}」吗？删除后无法恢复。`,
      '删除定时模板',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await store.remove(template.id)
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

onMounted(() => {
  void loadAll()
})
</script>

<template>
  <div class="tpl-page">
    <div class="tpl-header">
      <div>
        <h1 class="tpl-title">定时模板</h1>
        <p class="tpl-subtitle">沉淀常用的定时任务配置，一键套用</p>
      </div>
      <div class="tpl-header-actions">
        <button class="tpl-btn tpl-btn--ghost" @click="handleRefresh">
          <RefreshCw :size="14" :class="{ spinning: refreshing }" />
          刷新
        </button>
        <button class="tpl-btn tpl-btn--primary" @click="openCreate">
          <Plus :size="15" />
          新建模板
        </button>
      </div>
    </div>

    <p v-if="store.error" class="tpl-error">{{ store.error }}</p>

    <!-- 类型筛选 + 搜索 + 视图切换 -->
    <div class="tpl-toolbar">
      <div class="tpl-chips">
        <button
          class="tpl-chip"
          :class="{ 'tpl-chip--active': store.categoryFilter === '' }"
          @click="handleCategoryChange('')"
        >
          全部
        </button>
        <button
          v-for="item in store.types"
          :key="item.value"
          class="tpl-chip"
          :class="{ 'tpl-chip--active': store.categoryFilter === item.value }"
          @click="handleCategoryChange(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
      <div class="tpl-toolbar-right">
        <div class="tpl-search">
          <Search :size="14" />
          <input
            v-model="store.keyword"
            type="text"
            placeholder="搜索模板名称或描述"
            @keydown.enter="handleKeywordChange"
          />
        </div>
        <div class="tpl-toggle">
          <button
            :class="{ active: store.viewMode === 'card' }"
            title="卡片视图"
            aria-label="卡片视图"
            @click="store.viewMode = 'card'"
          >
            <LayoutGrid :size="15" />
          </button>
          <button
            :class="{ active: store.viewMode === 'table' }"
            title="表格视图"
            aria-label="表格视图"
            @click="store.viewMode = 'table'"
          >
            <List :size="15" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="store.loading" class="tpl-loading">加载中…</p>

    <template v-else-if="isEmpty">
      <div class="tpl-empty">
        <p>{{ emptyText }}</p>
        <button
          v-if="!store.keyword && !store.categoryFilter"
          class="tpl-btn tpl-btn--primary"
          @click="openCreate"
        >
          <Plus :size="15" />
          新建模板
        </button>
      </div>
    </template>

    <!-- 卡片视图 -->
    <div v-else-if="store.viewMode === 'card'" class="tpl-grid">
      <div v-for="template in store.templates" :key="template.id" class="tpl-card">
        <div class="tpl-card-top">
          <span class="tpl-card-icon">{{ template.icon }}</span>
          <div class="tpl-card-heading">
            <p class="tpl-card-title" :title="template.name">{{ template.name }}</p>
            <div class="tpl-card-tags">
              <span class="tpl-tag">{{ typeLabel(template.category) }}</span>
              <span class="tpl-version">v{{ template.version }}</span>
            </div>
          </div>
        </div>
        <p class="tpl-card-desc">{{ template.description || template.promptText }}</p>
        <div class="tpl-card-foot">
          <span class="tpl-meta">{{ template.freqSummary }}</span>
          <div class="tpl-card-actions">
            <button
              class="tpl-add-btn"
              :class="{ 'tpl-add-btn--added': store.addedTemplateIds.has(template.id) }"
              :disabled="store.addedTemplateIds.has(template.id) || store.addingId === template.id"
              @click="handleAddToTasks(template)"
            >
              <Check v-if="store.addedTemplateIds.has(template.id)" :size="13" />
              <Plus v-else :size="13" />
              {{
                store.addedTemplateIds.has(template.id)
                  ? '已添加'
                  : store.addingId === template.id
                    ? '添加中…'
                    : '添加到定时任务'
              }}
            </button>
            <button
              class="tpl-icon-btn"
              title="编辑"
              aria-label="编辑"
              @click="openEdit(template)"
            >
              <Pencil :size="14" />
            </button>
            <button
              class="tpl-icon-btn tpl-icon-btn--danger"
              title="删除"
              aria-label="删除"
              @click="handleDelete(template)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 表格视图（窄屏横向滚动，见 .tpl-table-inner 的最小宽度） -->
    <div v-else class="tpl-table">
      <div class="tpl-table-inner">
        <div class="tpl-table-head">
          <span>模板名称</span>
          <span>类型</span>
          <span>版本</span>
          <span>执行计划</span>
          <span>有效期</span>
          <span>更新时间</span>
          <span class="tpl-col-right">操作</span>
        </div>
        <div v-for="template in store.templates" :key="template.id" class="tpl-table-row">
          <div class="tpl-cell-name">
            <span class="tpl-cell-icon">{{ template.icon }}</span>
            <div>
              <p class="tpl-cell-title" :title="template.name">{{ template.name }}</p>
              <p class="tpl-cell-sub">{{ template.description || template.promptText }}</p>
            </div>
          </div>
          <span>{{ typeLabel(template.category) }}</span>
          <span class="tpl-cell-version">v{{ template.version }}</span>
          <span>{{ template.freqSummary }}</span>
          <span>{{ template.validitySummary }}</span>
          <span>{{ formatTime(template.updatedAt) }}</span>
          <div class="tpl-cell-actions">
            <button
              class="tpl-add-btn tpl-add-btn--sm"
              :class="{ 'tpl-add-btn--added': store.addedTemplateIds.has(template.id) }"
              :disabled="store.addedTemplateIds.has(template.id) || store.addingId === template.id"
              @click="handleAddToTasks(template)"
            >
              <Check v-if="store.addedTemplateIds.has(template.id)" :size="12" />
              <Plus v-else :size="12" />
              {{ store.addedTemplateIds.has(template.id) ? '已添加' : '添加' }}
            </button>
            <button class="tpl-icon-btn" title="编辑" aria-label="编辑" @click="openEdit(template)">
              <Pencil :size="14" />
            </button>
            <button
              class="tpl-icon-btn tpl-icon-btn--danger"
              title="删除"
              aria-label="删除"
              @click="handleDelete(template)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 共 N 条 / 每页条数可选 / 上一页·页码·下一页 / 前往第 N 页 -->
    <div v-if="!isEmpty" class="tpl-pagination">
      <el-pagination
        :current-page="store.page"
        :page-size="store.pageSize"
        :page-sizes="[...PAGE_SIZE_OPTIONS]"
        :total="store.total"
        :layout="PAGINATION_LAYOUT"
        background
        size="small"
        @current-change="handlePageChange"
        @size-change="handlePageSizeChange"
      />
    </div>

    <ScheduleTemplateDialog
      v-if="showDialog"
      :template="editingTemplate"
      @close="closeDialog"
      @saved="handleSaved"
    />
  </div>
</template>

<style scoped lang="scss">
/*
 * 外壳 .work-area 是 overflow: hidden，滚动必须由页面自己负责——否则内容一高
 * （模板一多）底部连分页条一起被裁掉，翻页就够不着了。与「定时任务」页一致。
 */
.tpl-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px 32px;
  background: var(--surface-primary);
}

.tpl-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.tpl-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--foreground-primary);
}

.tpl-subtitle {
  margin: 4px 0 0;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.tpl-header-actions {
  display: flex;
  gap: 8px;
}

.tpl-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tpl-btn--primary {
  background: var(--accent-primary);
  color: #fff;
}

.tpl-btn--ghost {
  border-color: var(--border-medium);
  background: transparent;
  color: var(--foreground-muted);
}

.tpl-btn--ghost:hover {
  color: var(--foreground-primary);
}

.spinning {
  animation: tpl-spin 0.8s linear infinite;
}

@keyframes tpl-spin {
  to {
    transform: rotate(360deg);
  }
}

.tpl-error {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  background: rgba(239, 68, 68, 0.1);
  color: var(--color-danger, #ef4444);
  font-size: var(--font-size-xs);
}

.tpl-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.tpl-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tpl-chip {
  padding: 5px 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.tpl-chip--active {
  border-color: var(--accent-primary);
  background: var(--accent-primary);
  color: #fff;
}

.tpl-toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tpl-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-muted);
}

.tpl-search input {
  border: none;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
  outline: none;
  width: 180px;
}

.tpl-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
}

.tpl-toggle button {
  display: inline-flex;
  padding: 5px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.tpl-toggle button.active {
  background: var(--accent-primary);
  color: #fff;
}

.tpl-loading,
.tpl-empty {
  padding: 48px 0;
  text-align: center;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
}

.tpl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

/* 卡片列宽自适应：宽屏多列、窄屏自动减列。
 * `min(100%, 300px)` 是为了在比 300px 还窄的视口下也不撑破容器。 */
.tpl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 14px;
}

.tpl-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl, 14px);
  background: var(--surface-secondary);
}

.tpl-card-top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.tpl-card-icon {
  font-size: 22px;
  line-height: 1;
}

.tpl-card-heading {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.tpl-card-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-card-tags {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tpl-tag {
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: rgba(99, 102, 241, 0.12);
  color: #818cf8;
  font-size: 11px;
}

.tpl-version {
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: rgba(148, 163, 184, 0.14);
  color: var(--foreground-muted);
  font-size: 11px;
}

.tpl-card-desc {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tpl-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
}

.tpl-meta {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.tpl-card-actions,
.tpl-cell-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 「添加到定时任务」：卡片里带文案，表格里压缩成短标签 */
.tpl-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 2px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: var(--accent-primary);
  color: #fff;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.tpl-add-btn:hover:not(:disabled) {
  opacity: 0.88;
}

.tpl-add-btn--sm {
  padding: 4px 8px;
}

.tpl-add-btn--added,
.tpl-add-btn:disabled {
  border-color: var(--border-medium);
  background: transparent;
  color: var(--foreground-muted);
  cursor: default;
}

.tpl-icon-btn {
  display: inline-flex;
  padding: 5px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.tpl-icon-btn:hover {
  background: rgba(148, 163, 184, 0.16);
  color: var(--foreground-primary);
}

.tpl-icon-btn--danger:hover {
  color: var(--color-danger, #ef4444);
}

/* 列多，窄屏下改用横向滚动而不是把每列压变形。
 *
 * `flex: none` 不能省：.tpl-page 是定高的 flex 列容器，而滚动容器（overflow 非 visible）
 * 的 min-height 会解析成 0，于是表格会被挤扁、自己长出竖向滚动条、把后面的行裁掉。
 * 固定住它的高度，让滚动只发生在页面这一层。 */
.tpl-table {
  flex: none;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl, 14px);
  overflow-x: auto;
}

.tpl-table-inner {
  min-width: 940px;
}

.tpl-table-head,
.tpl-table-row {
  display: grid;
  grid-template-columns: minmax(200px, 2fr) 92px 76px minmax(110px, 1fr) minmax(110px, 1fr) 100px 168px;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
}

.tpl-table-head {
  background: var(--surface-secondary);
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.tpl-table-row {
  border-top: 1px solid var(--border-medium);
  font-size: var(--font-size-xs);
  color: var(--foreground-primary);
}

.tpl-table-row:hover {
  background: rgba(148, 163, 184, 0.06);
}

.tpl-col-right {
  text-align: right;
}

.tpl-cell-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tpl-cell-icon {
  font-size: 16px;
}

.tpl-cell-title {
  margin: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-cell-sub {
  margin: 2px 0 0;
  color: var(--foreground-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-cell-version {
  font-variant-numeric: tabular-nums;
}

.tpl-pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  /* 分页条固定在内容之后；内容再长也能滚到它 */
  padding-top: 4px;
}

/* 窄屏：收窄内外边距，并把分页条撑满一行，避免被挤成两行错位 */
@media (max-width: 900px) {
  .tpl-page {
    padding: 16px 14px 24px;
  }

  .tpl-search input {
    width: 120px;
  }

  .tpl-pagination {
    justify-content: center;
  }
}
</style>
