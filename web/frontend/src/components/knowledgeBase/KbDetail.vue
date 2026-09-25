<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Database, ChevronRight, RefreshCw, Trash2, Globe, Lock, Share2,
  Activity, FileText, Network, FileSearch, Settings2,
} from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import type { KB } from '@/types/knowledgeBase'
import { KB_STATUS_CONFIG } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import KbOverviewTab from './KbOverviewTab.vue'
import KbDocsTab from './KbDocsTab.vue'
import KbGraphTab from './KbGraphTab.vue'
import KbSearchTab from './KbSearchTab.vue'
import KbConfigTab from './KbConfigTab.vue'
import KbShareDialog from './KbShareDialog.vue'
import KbShareManageDialog from './KbShareManageDialog.vue'
import { useKbPermissions } from '@/composables/useKbPermissions'

const props = defineProps<{
  kb: KB
}>()

const emit = defineEmits<{
  back: []
  delete: []
  update: [patch: Partial<KB>]
  changed: []
}>()

const store = useKnowledgeBaseStore()
const router = useRouter()
const activeTab = ref('overview')
const reindexing = ref(false)
const shareVisible = ref(false)
const shareManageVisible = ref(false)
const publishing = ref(false)

const statusCfg = KB_STATUS_CONFIG[props.kb.status]

/** 非所有者（公共库 / 被分享）进入只读态：隐藏全部写入口 */
const readonly = computed(() => !props.kb.isOwner)

// 角色权限是**第二条轴**：库是自己的不代表当前角色有权改（见 useKbPermissions）。
// 各动作按后端接线的权限键分别判定，不再用一个布尔兜住所有写操作。
const { canEdit, canUpload, canDelete } = useKbPermissions()
const isPublic = computed(() => props.kb.visibility === 'public')

/** 来源标识：公共库 / 他人分享 */
const sourceLabel = computed(() => {
  if (readonly.value && isPublic.value) return '公共知识库'
  if (readonly.value) return props.kb.ownerName ? `由 ${props.kb.ownerName} 分享` : '他人分享'
  return ''
})

function handleGoHome() {
  store.clearSelection()
  router.push({ name: 'overview' })
}

function handleBackList() {
  emit('back')
}

async function handleToggleVisibility() {
  publishing.value = true
  try {
    await store.setVisibility(
      props.kb.id,
      isPublic.value ? 'private' : 'public',
    )
    ElMessage.success(isPublic.value ? '已取消发布' : '已发布到公共知识库')
    emit('changed')
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  } finally {
    publishing.value = false
  }
}

async function handleReindex() {
  try {
    await ElMessageBox.confirm(
      '将按当前配置重新索引全部文档，已有向量与图谱会被重建。',
      '确认重新索引？',
      { type: 'warning', confirmButtonText: '重新索引', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    reindexing.value = true
    const result = await store.reindexKb(props.kb.id, props.kb.config)
    warnIfCollectionBroken(result)
  } catch (err: unknown) {
    ElMessage.error(err instanceof Error ? err.message : '重新索引失败')
  } finally {
    reindexing.value = false
  }
}

/**
 * 重新索引后提示结果。
 *
 * ``collectionReady=false`` 表示向量集合重建失败——旧向量此时已不可用，
 * 必须显式告警，否则用户会以为"只是慢"。
 */
function warnIfCollectionBroken(
  result: { reindexed: number; collectionReady: boolean },
  successText = '已开始重新索引',
) {
  if (result.collectionReady) {
    ElMessage.success(successText)
  } else {
    ElMessage.error(
      `向量集合重建失败，${result.reindexed} 个文档的索引结果不可用，请联系管理员检查向量库`,
    )
  }
}

function handleConfigSave(config: typeof props.kb.config) {
  emit('update', { config })
}

async function handleSaveAndReindex(config: typeof props.kb.config) {
  try {
    reindexing.value = true
    const result = await store.reindexKb(props.kb.id, config)
    warnIfCollectionBroken(result, '配置已保存，正在重新索引全部文档')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '重新索引失败'
    ElMessage.error(msg)
  } finally {
    reindexing.value = false
  }
}
</script>

<template>
  <div class="kb-detail">
    <!-- 粘性顶栏 -->
    <div class="detail-header">
      <div class="detail-header-inner">
        <div class="header-left">
          <nav class="detail-crumbs" aria-label="breadcrumb">
            <button class="crumb-link" @click="handleGoHome">首页</button>
            <ChevronRight :size="12" class="crumb-sep" />
            <button class="crumb-link" @click="handleBackList">知识库</button>
            <ChevronRight :size="12" class="crumb-sep" />
            <span class="crumb-current">{{ kb.name }}</span>
          </nav>
          <div class="kb-icon-box">
            <Database :size="20" />
          </div>
          <div class="header-info">
            <div class="header-name-row">
              <h1 class="header-name">{{ kb.name }}</h1>
              <el-tag :class="['status-tag', statusCfg.cls]" size="small" disable-transitions>
                {{ statusCfg.label }}
              </el-tag>
              <el-tag
                v-if="readonly"
                :class="['source-tag', isPublic ? 'source-public' : 'source-shared']"
                size="small"
                disable-transitions
              >
                <Globe v-if="isPublic" :size="10" class="tag-icon" />
                <Lock v-else :size="10" class="tag-icon" />
                {{ sourceLabel }}
              </el-tag>
            </div>
            <p class="header-desc">{{ kb.description }}</p>
          </div>
        </div>
        <!-- 只读态（公共库 / 他人分享）不显示任何写操作；角色无对应权限键时同样隐藏 -->
        <div v-if="!readonly && (canEdit || canDelete)" class="header-actions">
          <template v-if="canEdit">
            <el-button :loading="publishing" @click="handleToggleVisibility">
              <Globe v-if="!isPublic" :size="16" class="btn-icon" />
              <Lock v-else :size="16" class="btn-icon" />
              {{ isPublic ? '取消发布' : '发布到公共知识库' }}
            </el-button>
            <el-button @click="shareVisible = true">
              <Share2 :size="16" class="btn-icon" />分享
            </el-button>
            <el-button @click="shareManageVisible = true">
              已分享用户
            </el-button>
            <el-button :loading="reindexing" @click="handleReindex">
              <RefreshCw :size="16" class="btn-icon" />重新索引
            </el-button>
          </template>
          <el-button v-if="canDelete" class="btn-delete" @click="$emit('delete')">
            <Trash2 :size="16" class="btn-icon" />删除
          </el-button>
        </div>
      </div>
    </div>

    <!-- Tab 内容 -->
    <div class="detail-body">
      <el-tabs v-model="activeTab" class="kb-tabs">
        <el-tab-pane name="overview">
          <template #label>
            <Activity :size="14" class="tab-icon" />概览
          </template>
          <KbOverviewTab :kb="kb" :readonly="readonly || !canEdit" />
        </el-tab-pane>

        <el-tab-pane name="docs">
          <template #label>
            <FileText :size="14" class="tab-icon" />文档 ({{ kb.documents.length }})
          </template>
          <KbDocsTab :kb="kb" :readonly="readonly || !canUpload" />
        </el-tab-pane>

        <el-tab-pane name="graph">
          <template #label>
            <Network :size="14" class="tab-icon" />知识图谱
          </template>
          <KbGraphTab :kb="kb" :readonly="readonly || !canEdit" />
        </el-tab-pane>

        <el-tab-pane name="search">
          <template #label>
            <FileSearch :size="14" class="tab-icon" />检索
          </template>
          <KbSearchTab :kb="kb" />
        </el-tab-pane>

        <el-tab-pane name="config">
          <template #label>
            <Settings2 :size="14" class="tab-icon" />索引配置
          </template>
          <KbConfigTab
            :config="kb.config"
            :readonly="readonly || !canEdit"
            @save="handleConfigSave"
            @save-and-reindex="handleSaveAndReindex"
          />
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 分享 / 管理分享 -->
    <KbShareDialog
      :visible="shareVisible"
      :kb="kb"
      @close="shareVisible = false"
      @shared="emit('changed')"
    />
    <KbShareManageDialog
      :visible="shareManageVisible"
      :kb="kb"
      @close="shareManageVisible = false"
      @changed="emit('changed')"
    />
  </div>
</template>

<style scoped>
.kb-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-primary);
  overflow: hidden;
}

.detail-header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--surface-glass);
  backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--border-subtle);
}

.detail-header-inner {
  max-width: 1600px;
  margin: 0 auto;
  padding: 16px 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.detail-crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.crumb-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--foreground-secondary);
  cursor: pointer;
  transition: color 0.15s;
}

.crumb-link:hover {
  color: var(--accent-primary);
}

.crumb-sep {
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.crumb-current {
  color: var(--foreground-primary);
  font-weight: var(--font-weight-medium);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kb-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}

.header-info {
  min-width: 0;
}

.header-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-name {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--foreground-primary);
  margin: 0;
}

.tag-icon {
  margin-right: 3px;
}

.source-tag {
  display: inline-flex;
  align-items: center;
}

.source-public {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
  border-color: rgba(59, 130, 246, 0.3);
}

.source-shared {
  background: rgba(139, 92, 246, 0.15);
  color: #c4b5fd;
  border-color: rgba(139, 92, 246, 0.3);
}

.status-tag {
  flex-shrink: 0;
}

.status-ready {
  background: rgba(16, 185, 129, 0.15);
  color: var(--status-ready-text);
  border-color: rgba(16, 185, 129, 0.3);
}

.status-indexing {
  background: rgba(59, 130, 246, 0.15);
  color: var(--status-indexing-text);
  border-color: rgba(59, 130, 246, 0.3);
}

.status-error {
  background: rgba(244, 63, 94, 0.15);
  color: var(--status-error-text);
  border-color: rgba(244, 63, 94, 0.3);
}

.status-draft {
  background: rgba(100, 116, 139, 0.15);
  color: var(--status-draft-text);
  border-color: rgba(100, 116, 139, 0.3);
}

.header-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.btn-delete {
  color: var(--status-error-text);
  border-color: rgba(244, 63, 94, 0.3);
  background: rgba(244, 63, 94, 0.1);
}

.btn-delete:hover {
  background: rgba(244, 63, 94, 0.2);
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 24px 32px;
}

.detail-body :deep(.el-tabs) {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-body :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.detail-body :deep(.el-tab-pane) {
  height: 100%;
  overflow-y: auto;
}

.kb-tabs {
  --el-tabs-header-height: 40px;
}

.kb-tabs :deep(.el-tabs__item) {
  color: var(--foreground-muted);
  transition: color 0.2s;
}

.kb-tabs :deep(.el-tabs__item.is-active) {
  color: var(--accent-primary);
}

.kb-tabs :deep(.el-tabs__item:hover:not(.is-active)) {
  color: var(--foreground-primary);
}

.tab-icon {
  margin-right: 4px;
  vertical-align: -2px;
}

.btn-icon {
  margin-right: 4px;
}
</style>
