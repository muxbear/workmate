<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, Wrench } from 'lucide-vue-next'
import { useToolStore } from '@/stores/tool'
import { fetchToolTypes } from '@/services/toolApi'
import { useParamTypes } from '@/composables/useParamTypes'
import { useClientPagination } from '@/composables/useClientPagination'
import { PAGINATION_LAYOUT, PAGE_SIZE_OPTIONS } from '@/types/pagination'
import type { Tool, ToolCreateRequest, ToolStatus } from '@/types/tool'
import { CATEGORY_META, STATUS_META } from '@/types/tool'
import ToolCard from '@/components/tool/ToolCard.vue'
import ToolDialog from '@/components/tool/ToolDialog.vue'
import ToolDetailDrawer from '@/components/tool/ToolDetailDrawer.vue'

const toolStore = useToolStore()

// -- Category filter --
// 类型清单来自「参数配置」的 tool_type 分组（未配置则筛选项为空）
const { options: typeOptions, load: loadTypes } = useParamTypes(fetchToolTypes)
const categoryFilter = ref<string>('all')

/** 已知分类沿用既有配色；参数配置里新增的分类回退为中性灰 */
const NEUTRAL_CATEGORY_META = {
  label: '',
  color: 'var(--color-tool-gray, #94a3b8)',
  bg: 'rgba(148,163,184,0.08)',
  border: 'rgba(148,163,184,0.2)',
}

function categoryMeta(value: string): { label: string; color: string; bg: string; border: string } {
  const known = CATEGORY_META[value as keyof typeof CATEGORY_META]
  const label = typeOptions.value.find((item) => item.value === value)?.label ?? value
  return known ? { ...known, label } : { ...NEUTRAL_CATEGORY_META, label }
}

// -- Status filter --
const statusFilter = ref<ToolStatus | 'all'>('all')

// -- Search --
const search = ref('')

// -- Dialog state --
const editing = ref<Tool | null | 'new'>(null)
const deleting = ref<Tool | null>(null)
const detail = ref<Tool | null>(null)

// -- Stats --
const builtinCount = computed(() => toolStore.tools.filter((t) => t.source === 'builtin').length)
const thirdPartyCount = computed(() => toolStore.tools.filter((t) => t.source === 'third-party').length)

const statCards = computed(() => [
  { label: '工具总数', value: toolStore.tools.length, color: '#6366f1', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.18)' },
  { label: '内置工具', value: builtinCount.value, color: '#818cf8', bg: 'rgba(99,102,241,0.04)', border: 'rgba(99,102,241,0.15)' },
  { label: '第三方工具', value: thirdPartyCount.value, color: '#a78bfa', bg: 'rgba(168,85,247,0.04)', border: 'rgba(168,85,247,0.15)' },
  { label: '已启用', value: toolStore.enabledTools.length, color: '#34d399', bg: 'rgba(16,185,129,0.04)', border: 'rgba(16,185,129,0.15)' },
  { label: '已禁用', value: toolStore.disabledTools.length, color: '#fbbf24', bg: 'rgba(245,158,11,0.04)', border: 'rgba(245,158,11,0.15)' },
  { label: '不可用', value: toolStore.unavailableTools.length, color: '#94a3b8', bg: 'rgba(148,163,184,0.03)', border: 'rgba(148,163,184,0.15)' },
])

// -- Category counts（整份列表，不再按来源页签细分——来源筛选已移除） --
const categoryCounts = computed(() => {
  const map: Record<string, number> = {}
  for (const t of toolStore.tools) {
    map[t.category] = (map[t.category] ?? 0) + 1
  }
  return map
})

// -- Filtered tools --
const filtered = computed(() => {
  return toolStore.tools.filter((t) => {
    if (categoryFilter.value !== 'all' && t.category !== categoryFilter.value) return false
    if (statusFilter.value !== 'all' && t.status !== statusFilter.value) return false
    if (search.value) {
      const kw = search.value.toLowerCase()
      if (
        !t.displayName.toLowerCase().includes(kw) &&
        !t.name.toLowerCase().includes(kw) &&
        !t.tags.some((tag) => tag.toLowerCase().includes(kw))
      ) return false
    }
    return true
  })
})

// -- 只显示确实有工具的分类（数量为 0 的不显示） --
const activeCategories = computed(() => {
  return typeOptions.value
    .map((item) => item.value)
    .filter((value) => (categoryCounts.value[value] ?? 0) > 0)
})

// -- Status filter buttons --
const statusFilters: { key: ToolStatus | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'enabled', label: '已启用' },
  { key: 'disabled', label: '已禁用' },
  { key: 'unavailable', label: '不可用' },
]

// -- Actions --
function openCreate() { editing.value = 'new' }

function openEdit(tool: Tool) {
  if (tool.source === 'builtin') return
  editing.value = tool
}

function closeDialog() { editing.value = null }

async function handleSave(data: ToolCreateRequest) {
  try {
    if (editing.value && editing.value !== 'new') {
      await toolStore.editTool(editing.value.id, data)
      ElMessage.success('工具已更新')
    } else {
      await toolStore.addTool(data)
      ElMessage.success('工具创建成功')
    }
    closeDialog()
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function handleToggle(id: string) {
  const tool = toolStore.tools.find((t) => t.id === id)
  if (!tool) return
  try {
    const nextEnabled = tool.status !== 'enabled'
    await toolStore.toggleToolEnabled(id, nextEnabled)
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function handleDelete(id: string) {
  const tool = toolStore.tools.find((t) => t.id === id)
  if (!tool) return
  deleting.value = tool
  try {
    await ElMessageBox.confirm(
      `确定要删除工具"${tool.displayName}"吗？`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
    await toolStore.removeTool(id)
    ElMessage.success('工具已删除')
  } catch (err: unknown) {
    if (err instanceof Error && err.message !== 'cancel') {
      ElMessage.error(err.message)
    }
  } finally {
    deleting.value = null
  }
}

function openDetail(tool: Tool) { detail.value = tool }
function closeDetail() { detail.value = null }

// -- 分页 --
// 整份列表在前端切片分页，不用后端分页：分类 chips 上的数量、「只显示有工具的分类」
// 都是基于整份列表算的，换成后端分页这些计数会变成「本页的数量」。
const { page, pageSize, total, paged, reset } = useClientPagination(filtered)

// 筛选条件一变就回第一页，否则会停在一个与当前条件无关的页码上
watch([categoryFilter, statusFilter, search], reset)

onMounted(() => {
  toolStore.fetchTools()
  void loadTypes()
})
</script>

<template>
  <div class="tools-page">
    <!-- ── Header ── -->
    <div class="page-header">
      <div class="page-header__info">
        <h1 class="page-title">工具</h1>
        <p class="page-sub">内置工具与第三方工具统一管理</p>
      </div>
      <el-button type="primary" size="large" @click="openCreate">
        <Plus :size="16" class="btn-icon" />
        添加第三方工具
      </el-button>
    </div>

    <!-- ── Stats ── -->
    <div class="stats-bar">
      <div
        v-for="s in statCards"
        :key="s.label"
        class="stat-card"
        :style="{ background: s.bg, borderColor: s.border }"
      >
        <span class="stat-label">{{ s.label }}</span>
        <span class="stat-value" :style="{ color: s.color }">{{ s.value }}</span>
      </div>
    </div>

    <!-- ── Filters + Search ── -->
    <div class="filters-row">
      <!-- Search -->
      <div class="search-box">
        <Search :size="14" class="search-icon" />
        <input
          v-model="search"
          type="text"
          class="search-input"
          placeholder="搜索工具名称、标签…"
        />
      </div>

      <!-- Category filter chips -->
      <div class="category-chips">
        <button
          class="chip-btn"
          :class="{ active: categoryFilter === 'all' }"
          @click="categoryFilter = 'all'"
        >
          全部分类
        </button>
        <button
          v-for="c in activeCategories"
          :key="c"
          class="chip-btn"
          :class="{ active: categoryFilter === c }"
          :style="categoryFilter === c
            ? { background: categoryMeta(c).bg, color: categoryMeta(c).color, borderColor: categoryMeta(c).border }
            : {}"
          @click="categoryFilter = categoryFilter === c ? 'all' : c"
        >
          <span>{{ categoryMeta(c).label }}</span>
          <span class="chip-count">{{ categoryCounts[c] }}</span>
        </button>
      </div>

      <!-- Status filter -->
      <div class="status-filters">
        <button
          v-for="sf in statusFilters"
          :key="sf.key"
          class="status-btn"
          :class="{ active: statusFilter === sf.key }"
          @click="statusFilter = sf.key"
        >
          {{ sf.label }}
        </button>
      </div>
    </div>

    <!-- ── Tool Grid ── -->
    <div class="section-header">
      <span class="section-title">工具列表</span>
      <span class="section-count">共 {{ filtered.length }} 个工具</span>
    </div>

    <div v-loading="toolStore.loading" class="tools-content">
      <!-- Loading -->
      <div v-if="toolStore.loading" class="tools-grid">
        <div v-for="i in 6" :key="i" class="skeleton-card">
          <el-skeleton :rows="3" animated />
        </div>
      </div>

      <!-- Empty -->
      <el-empty
        v-else-if="filtered.length === 0"
        :description="categoryFilter !== 'all' || statusFilter !== 'all' || search ? '当前筛选条件下没有匹配的工具' : '暂无工具'"
      >
        <el-button v-if="!search" type="primary" @click="openCreate">
          添加第三方工具
        </el-button>
      </el-empty>

      <!-- Grid（当前页） -->
      <div v-else class="tools-grid">
        <ToolCard
          v-for="tool in paged"
          :key="tool.id"
          :tool="tool"
          @edit="openEdit"
          @delete="handleDelete"
          @toggle="handleToggle"
          @detail="openDetail"
        />
      </div>
    </div>

    <!-- 分页：共 N 条 / 改每页条数 / 翻页 / 跳页（与「定时模板」页同一套） -->
    <div v-if="!toolStore.loading && total > 0" class="tools-pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[...PAGE_SIZE_OPTIONS]"
        :total="total"
        :layout="PAGINATION_LAYOUT"
        background
        size="small"
      />
    </div>

    <!-- ── Dialogs ── -->
    <ToolDialog
      :visible="editing !== null"
      :tool="editing !== 'new' ? editing : null"
      @close="closeDialog"
      @save="handleSave"
    />

    <ToolDetailDrawer
      v-if="detail"
      :tool="detail"
      @close="closeDetail"
      @edit="(t: Tool) => { closeDetail(); openEdit(t) }"
      @delete="(id: string) => { closeDetail(); handleDelete(id) }"
    />
  </div>
</template>

<style scoped>
.tools-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 32px;
  height: 100%;
  overflow-y: auto;
  background: var(--surface-primary);
}

/* Page Header */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-header__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.page-title {
  font-size: 28px;
  font-weight: var(--font-weight-bold);
  background: linear-gradient(90deg, #818cf8, #a78bfa, #60a5fa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin: 0;
  line-height: 1.3;
}

.page-sub {
  font-size: var(--font-size-base);
  color: var(--foreground-muted);
  margin: 0;
}

.btn-icon { margin-right: 6px; }

/* Stats Bar */
.stats-bar {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px 20px;
  border-radius: 14px;
  border: 1px solid;
}

.stat-label {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

.stat-value {
  font-size: 28px;
  font-weight: var(--font-weight-bold);
}

/* Source Tabs */

/* Filters Row */
.filters-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

/* Search */
.search-box {
  position: relative;
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-muted);
  pointer-events: none;
}

.search-input {
  width: 240px;
  padding: 7px 12px 7px 30px;
  background: var(--color-bg-input);
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-base);
  color: var(--color-text-primary);
  font-family: var(--font-family-base);
  outline: none;
}

.search-input::placeholder { color: var(--foreground-muted); }
.search-input:focus { border-color: var(--accent-primary); }

/* Category chips */
.category-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-family-base);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.chip-btn:hover { color: var(--color-text-primary); }

.chip-btn.active {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.chip-count {
  opacity: 0.6;
  font-size: 11px;
}

/* Status filters */
.status-filters {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--surface-secondary);
  border-radius: var(--radius-lg);
  margin-left: auto;
}

.status-btn {
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-family-base);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.status-btn:hover { color: var(--color-text-primary); }

.status-btn.active {
  background: var(--accent-primary);
  color: #fff;
}

/* Section */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.section-count {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}

/* Tools Grid */
/*
 * flex: none 不能省。.tools-page 是定高的 flex 列容器，而这里的 min-height 允许它被压缩，
 * 网格比它高时就会溢出，后面的分页条便被摆到网格上面（视觉上压在卡片上）。
 * 固定成内容高度，滚动交给 .tools-page。
 */
.tools-content {
  flex: none;
  min-height: 200px;
}

.tools-pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

@media (max-width: 900px) {
  .tools-pagination {
    justify-content: center;
  }
}

.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}

.skeleton-card {
  padding: 20px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
}

/* Load more */

</style>
