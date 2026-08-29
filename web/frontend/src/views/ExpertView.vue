<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, X, Star, RefreshCw } from 'lucide-vue-next'
import { useExpertStore } from '@/stores/expert'
import type { Expert, ExpertUpdateRequest, ExpertProfileUpdateRequest, ExpertConfigUpdateRequest } from '@/types/expert'
import { EXPERT_CATEGORY_FILTERS } from '@/types/expert'
import ExpertCard from '@/components/expert/ExpertCard.vue'
import ExpertEditDialog from '@/components/expert/ExpertEditDialog.vue'

const expertStore = useExpertStore()

/* ---- dialog state ---- */
const editVisible = ref(false)
const editMode = ref<'create' | 'edit'>('create')
const editingExpert = ref<Expert | null>(null)

/* ---- featured scene ---- */
const featuredSceneExpanded = ref(true)

/* ---- sort options ---- */
const sortOptions = [
  { key: 'rating' as const, label: '评分' },
  { key: 'usage' as const, label: '使用量' },
  { key: 'recent' as const, label: '最新' },
  { key: 'name' as const, label: '名称' },
]

/* ---- handlers ---- */
function handleSearch() {
  expertStore.resetPage()
  expertStore.fetchExperts()
}

function handleCategoryChange(key: string) {
  expertStore.categoryFilter = key
  expertStore.resetPage()
  expertStore.fetchExperts()
}

function handleSortChange(key: 'rating' | 'usage' | 'recent' | 'name') {
  expertStore.sortBy = key
  expertStore.fetchExperts()
}

function handlePageChange(newPage: number) {
  expertStore.page = newPage
  expertStore.fetchExperts()
}

function openCreateDialog() {
  editingExpert.value = null
  editMode.value = 'create'
  editVisible.value = true
}

function openEditDialog(expert: Expert) {
  editingExpert.value = expert
  editMode.value = 'edit'
  editVisible.value = true
}

async function handleEditSave(data: {
  basic: ExpertUpdateRequest
  profile: ExpertProfileUpdateRequest
  config: ExpertConfigUpdateRequest
}) {
  try {
    if (editMode.value === 'create') {
      await expertStore.createExpert({
        name: data.basic.name,
        title: data.profile.title || data.basic.title,
        description: data.basic.description,
        systemPrompt: data.basic.systemPrompt || data.config.systemPrompt || '',
        category: data.profile.category || 'custom',
        tags: data.profile.tags || [],
        icon: data.profile.icon || '',
        color: data.profile.color || '',
        initials: data.profile.initials || '',
        providerId: data.basic.providerId,
        modelId: data.basic.modelId,
        toolNames: data.config.toolNames || [],
        skillIds: data.config.skillIds || [],
        mcpConfigs: data.config.mcpConfigs || [],
        featured: data.profile.featured || false,
        scene: data.profile.scene,
      })
      ElMessage.success('专家创建成功')
    } else {
      const id = editingExpert.value?.id
      if (!id) return
      await expertStore.updateExpert(id, data.basic)
      await expertStore.updateExpertProfile(id, data.profile)
      await expertStore.updateExpertConfig(id, data.config)
      ElMessage.success('专家已更新')
    }
    editVisible.value = false
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function handleDelete(expert: Expert) {
  try {
    await ElMessageBox.confirm(
      `确定要删除专家"${expert.name}"吗？此操作不可撤销。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
    await expertStore.deleteExpert(expert.id)
    ElMessage.success('专家已删除')
  } catch (err: unknown) {
    if (err instanceof Error && err.message !== 'cancel') {
      ElMessage.error(err.message)
    }
  }
}

async function handleToggle(expert: Expert) {
  try {
    await expertStore.toggleStatus(expert.id)
    ElMessage.success(expert.status === 'active' ? '已停用' : '已启用')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function handleClone(expert: Expert) {
  try {
    await expertStore.cloneExpert(expert.id)
    ElMessage.success('克隆成功')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '克隆失败')
  }
}

function handleRefresh() {
  expertStore.fetchExperts()
  ElMessage.success('已刷新')
}

onMounted(() => {
  expertStore.fetchExperts()
})
</script>

<template>
  <div class="experts-page">
    <!-- Page Header -->
    <div class="page-header">
      <div class="header-info">
        <h1>专家</h1>
        <p>管理专家的展示信息、模型配置、工具与技能</p>
      </div>
      <div class="header-actions">
        <div class="search-box">
          <Search :size="14" class="search-icon" />
          <input
            v-model="expertStore.searchQuery"
            class="search-input"
            placeholder="搜索专家..."
            @keyup.enter="handleSearch"
          />
          <button v-if="expertStore.searchQuery" class="search-clear" @click="expertStore.searchQuery = ''; handleSearch()">
            <X :size="12" />
          </button>
        </div>
        <el-button size="default" plain @click="handleRefresh">
          <RefreshCw :size="14" style="margin-right: 6px" />
          刷新
        </el-button>
        <el-button type="primary" size="default" @click="openCreateDialog">
          <Plus :size="14" style="margin-right: 6px" />
          新建专家
        </el-button>
      </div>
    </div>

    <!-- Error Banner -->
    <div v-if="expertStore.error" class="error-banner">
      <el-alert :title="expertStore.error" type="warning" show-icon :closable="true">
        <template #default>
          <el-button text size="small" @click="expertStore.fetchExperts()">重试</el-button>
        </template>
      </el-alert>
    </div>

    <!-- 精选场景 -->
    <div v-if="expertStore.featuredScenes.length > 0" class="scene-section">
      <div class="section-header">
        <span class="section-title">精选场景</span>
        <el-button text size="small" @click="featuredSceneExpanded = !featuredSceneExpanded">
          {{ featuredSceneExpanded ? '收起' : '展开' }}
        </el-button>
      </div>
      <div v-show="featuredSceneExpanded" class="scene-grid">
        <div
          v-for="scene in expertStore.featuredScenes"
          :key="scene.id"
          class="scene-card"
          :style="{ borderColor: scene.color.includes('135deg') ? 'rgba(59,130,246,0.2)' : scene.color }"
        >
          <div class="scene-card-head">
            <div class="scene-card-icon" :style="{ background: scene.color }">
              <Star :size="13" color="#fff" />
            </div>
            <span class="scene-card-label">{{ scene.label }}</span>
          </div>
          <div class="scene-items">
            <template v-if="scene.expertIds.length > 0">
              <div
                v-for="eid in scene.expertIds"
                :key="eid"
                class="scene-item"
              >
                <div class="scene-item-dot" :style="{ background: scene.color }" />
                <span>{{ expertStore.getFeaturedExpertName(eid) }}</span>
              </div>
            </template>
            <span v-else class="scene-empty-hint">暂无精选专家</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 分类筛选 + 排序 -->
    <div class="list-header">
      <div class="list-header-left">
        <span class="list-title">专家园</span>
        <span class="list-count">共 {{ expertStore.total }} 个</span>
      </div>
      <div class="list-header-right">
        <div class="sort-btns">
          <button
            v-for="opt in sortOptions"
            :key="opt.key"
            :class="['sort-btn', { 'sort-btn--active': expertStore.sortBy === opt.key }]"
            @click="handleSortChange(opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="filter-chips">
      <button
        v-for="cat in EXPERT_CATEGORY_FILTERS"
        :key="cat.key"
        :class="['filter-chip', { 'filter-chip--active': expertStore.categoryFilter === cat.key }]"
        @click="handleCategoryChange(cat.key)"
      >
        {{ cat.label }}
      </button>
    </div>

    <!-- 专家列表 -->
    <div v-loading="expertStore.loading" class="experts-content">
      <div v-if="expertStore.loading" class="expert-grid">
        <div v-for="i in 8" :key="i" class="skeleton-card">
          <el-skeleton :rows="4" animated />
        </div>
      </div>

      <el-empty
        v-else-if="expertStore.experts.length === 0"
        :description="expertStore.searchQuery || expertStore.categoryFilter ? '未找到匹配的专家' : '暂无专家，点击上方按钮创建'"
      >
        <el-button v-if="!expertStore.searchQuery && !expertStore.categoryFilter" type="primary" @click="openCreateDialog">
          <Plus :size="14" style="margin-right: 4px" />
          创建专家
        </el-button>
      </el-empty>

      <div v-else class="expert-grid">
        <ExpertCard
          v-for="expert in expertStore.experts"
          :key="expert.id"
          :expert="expert"
          @edit="openEditDialog"
          @delete="handleDelete"
          @toggle="handleToggle"
          @clone="handleClone"
        />
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="expertStore.total > expertStore.pageSize" class="pagination-bar">
      <el-pagination
        :current-page="expertStore.page"
        :page-size="expertStore.pageSize"
        :total="expertStore.total"
        layout="prev, pager, next"
        background
        @current-change="handlePageChange"
      />
    </div>

    <!-- Edit Dialog -->
    <ExpertEditDialog
      :visible="editVisible"
      :expert="editingExpert"
      :mode="editMode"
      @close="editVisible = false"
      @save="handleEditSave"
    />
  </div>
</template>

<style scoped>
.experts-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 32px;
  height: 100%;
  background: var(--surface-primary);
  overflow-y: auto;
  scrollbar-width: thin;
}

.experts-page::-webkit-scrollbar {
  width: 6px;
}

.experts-page::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 3px;
}

/* Page Header */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.header-info h1 {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--foreground-primary);
  margin: 0;
}

.header-info p {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  margin: 4px 0 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
}

.search-icon {
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.search-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  width: 160px;
}

.search-input::placeholder {
  color: var(--foreground-muted);
}

.search-clear {
  background: none;
  border: none;
  color: var(--foreground-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.search-clear:hover {
  color: var(--foreground-primary);
  background: var(--border-subtle);
}

/* Error Banner */
.error-banner {
  flex-shrink: 0;
}

/* Scene Section */
.scene-section {
  flex-shrink: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.scene-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.scene-card {
  border-radius: var(--radius-xl);
  padding: 14px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-card);
  cursor: pointer;
  transition: box-shadow var(--transition-fast);
}

.scene-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.scene-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.scene-card-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.scene-card-label {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.scene-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scene-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
}

.scene-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.scene-empty-hint {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

/* List Header */
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.list-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.list-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.list-count {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.sort-btns {
  display: flex;
  gap: 2px;
}

.sort-btn {
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  font-family: inherit;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.sort-btn:hover {
  color: var(--foreground-primary);
}

.sort-btn--active {
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

/* Filter Chips */
.filter-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.filter-chip {
  padding: 4px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: all var(--transition-fast);
}

.filter-chip:hover {
  border-color: rgba(59, 130, 246, 0.25);
  color: var(--foreground-primary);
}

.filter-chip--active {
  background: var(--accent-primary);
  color: #fff;
  border-color: var(--accent-primary);
}

/* Expert Grid */
.experts-content {
  flex: 1;
  min-height: 0;
}

.expert-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

.skeleton-card {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 20px;
}

/* Pagination */
.pagination-bar {
  display: flex;
  justify-content: center;
  padding: 8px 0;
  flex-shrink: 0;
}

/* Responsive */
@media (max-width: 1200px) {
  .scene-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .experts-page {
    padding: 16px;
  }

  .scene-grid {
    grid-template-columns: 1fr;
  }

  .expert-grid {
    grid-template-columns: 1fr;
  }
}
</style>
