<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Database, CheckCircle2, Loader2, CircleAlert, Pause,
  Sparkle, Scissors, Hash, Network,
  MoreVertical, Pin, PinOff, Pencil, Copy, Download, SquarePen,
} from 'lucide-vue-next'
import type { KB } from '@/types/knowledgeBase'
import { KB_STATUS_CONFIG, CHUNK_STRATEGY_OPTIONS } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { readApiError } from '@/services/knowledgeBaseApi'
import KbEditDialog from './KbEditDialog.vue'

const props = defineProps<{
  kb: KB
  /** 只读态（公共库 / 他人分享）：不展示组织操作 */
  readonly?: boolean
  /**
   * 不渲染右上角的三点菜单。
   *
   * 概览页（知识库概览）是"看一眼有哪些库"的地方，整顿操作统一在「查看更多」里做
   * ——两处都能改，改完看不出是哪儿改的。
   */
  hideMenu?: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const store = useKnowledgeBaseStore()
const { t } = useI18n()
const editVisible = ref(false)
const busy = ref(false)

/** 只有库主能整理自己的列表（置顶/排序是"我的视图偏好"） */
const canOrganize = () => !props.readonly && props.kb.isOwner

async function run(label: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
  } catch (err: unknown) {
    ElMessage.error(t('knowledge.common.actionFailed', { label, reason: readApiError(err) }))
  } finally {
    busy.value = false
  }
}

function handleCommand(command: string) {
  switch (command) {
    case 'pin':
      void run(props.kb.isPinned ? t('knowledge.card.unpin') : t('knowledge.card.pin'), () =>
        store.togglePin(props.kb.id, !props.kb.isPinned))
      break
    case 'rename':
      void handleRename()
      break
    case 'edit':
      editVisible.value = true
      break
    case 'copy':
      void run('复制', async () => {
        const created = await store.copyKb(props.kb.id)
        ElMessage.success(t('knowledge.card.copiedToast', { name: created.name }))
      })
      break
    case 'export':
      void run('导出', async () => {
        await store.exportKb(props.kb.id, props.kb.name)
        ElMessage.success(t('knowledge.card.exportedToast'))
      })
      break
  }
}

async function handleRename() {
  try {
    const { value } = await ElMessageBox.prompt(t('knowledge.card.renamePlaceholder'), t('knowledge.card.pinPromptTitle'), {
      inputValue: props.kb.name,
      inputValidator: (v: string) => (v && v.trim() ? true : t('knowledge.card.nameRequired')),
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    await run('重命名', () => store.updateKb(props.kb.id, { name: value.trim() }))
  } catch {
    // 用户取消
  }
}

const statusCfg = computed(() => KB_STATUS_CONFIG[props.kb.status])

const statusIcon = computed(() => {
  switch (props.kb.status) {
    case 'ready': return CheckCircle2
    case 'indexing': return Loader2
    case 'error': return CircleAlert
    case 'draft': return Pause
    default: return CheckCircle2
  }
})

const chunkLabel = computed(() => {
  const s = CHUNK_STRATEGY_OPTIONS.find((s) => s.value === props.kb.config.chunkStrategy)
  return s?.label || props.kb.config.chunkStrategy
})

function metricFormat(val: number): string {
  return val >= 1000 ? (val / 1000).toFixed(val % 1000 === 0 ? 0 : 1) + 'k' : String(val)
}
</script>

<template>
  <div
    class="kb-card"
    role="button"
    tabindex="0"
    @click="emit('click')"
    @keydown.enter="emit('click')"
    @keydown.space.prevent="emit('click')"
  >
    <!-- 头部 -->
    <div class="card-header">
      <div class="card-header-left">
        <div class="card-icon-box">
          <Database :size="20" />
        </div>
        <div class="card-title-area">
          <div class="card-title">{{ kb.name }}</div>
          <div class="card-meta">更新于 {{ kb.updatedAt }} · {{ kb.size }}</div>
        </div>
      </div>
      <div class="card-header-right" @click.stop>
        <el-tag v-if="kb.isPinned" class="pin-badge" size="small" disable-transitions>
          <Pin :size="12" />{{ t('knowledge.card.pin') }}
        </el-tag>
        <el-tag :class="['status-badge', statusCfg.cls]" size="small" disable-transitions>
          <component
            :is="statusIcon"
            :size="12"
            :class="{ 'spin-icon': kb.status === 'indexing' }"
          />
          {{ statusCfg.label }}
        </el-tag>
        <el-dropdown v-if="canOrganize() && !hideMenu" trigger="click" @command="handleCommand">
          <button class="card-menu-btn" :disabled="busy" :title="t('knowledge.common.moreActions')" :aria-label="t('knowledge.common.moreActions')">
            <MoreVertical :size="16" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pin">
                <PinOff v-if="kb.isPinned" :size="14" /><Pin v-else :size="14" />
                {{ kb.isPinned ? t('knowledge.card.unpin') : t('knowledge.card.pin') }}
              </el-dropdown-item>
              <el-dropdown-item command="rename" divided><Pencil :size="14" />{{ t('knowledge.card.rename') }}</el-dropdown-item>
              <el-dropdown-item command="edit"><SquarePen :size="14" />{{ t('knowledge.card.edit') }}</el-dropdown-item>
              <el-dropdown-item command="copy"><Copy :size="14" />{{ t('knowledge.card.copyWithConfig') }}</el-dropdown-item>
              <el-dropdown-item command="export"><Download :size="14" />{{ t('knowledge.card.exportConfig') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 描述 -->
    <p class="card-desc">{{ kb.description }}</p>

    <!-- 标签 -->
    <div class="card-tags">
      <el-tag
        v-for="t in kb.tags"
        :key="t"
        size="small"
        class="card-tag"
      >
        {{ t }}
      </el-tag>
    </div>

    <div class="card-divider" />

    <!-- 指标 -->
    <div class="card-metrics">
      <div class="metric">
        <span class="metric-value">{{ kb.docs }}</span>
        <span class="metric-label">{{ t('knowledge.common.docs') }}</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.chunks) }}</span>
        <span class="metric-label">{{ t('knowledge.common.chunks') }}</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.entities) }}</span>
        <span class="metric-label">{{ t('knowledge.card.entity') }}</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.relations) }}</span>
        <span class="metric-label">{{ t('knowledge.card.relations') }}</span>
      </div>
    </div>

    <!-- 配置标记 -->
    <div class="card-configs">
      <el-tag size="small" class="config-badge config-blue">
        <Sparkle :size="10" class="config-icon" />{{ kb.config.embeddingModel }}
      </el-tag>
      <el-tag size="small" class="config-badge config-purple">
        <Scissors :size="10" class="config-icon" />{{ chunkLabel }}
      </el-tag>
      <el-tag v-if="kb.config.sparseAlgo !== 'none'" size="small" class="config-badge config-amber">
        <Hash :size="10" class="config-icon" />{{ kb.config.sparseAlgo.toUpperCase() }}
      </el-tag>
      <el-tag v-if="kb.config.enableGraph" size="small" class="config-badge config-green">
        <Network :size="10" class="config-icon" />{{ t('knowledge.card.knowledgeGraph') }}
      </el-tag>
    </div>
    <!-- 编辑：名称 / 描述 / 标签 / 分组（原「重命名」与「归入分组」并到这里） -->
    <KbEditDialog
      :visible="editVisible"
      :kb="kb"
      @close="editVisible = false"
    />
  </div>
</template>

<style scoped>
.card-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pin-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.card-menu-btn {
  display: inline-flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
}

.kb-card {
  padding: 20px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: all 0.2s;
}

.kb-card:hover {
  border-color: rgba(59, 130, 246, 0.4);
  background: var(--surface-secondary);
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.card-header-left {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.card-icon-box {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(139, 92, 246, 0.2));
  border: 1px solid rgba(59, 130, 246, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #93c5fd;
  flex-shrink: 0;
}

.card-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.card-meta {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-top: 2px;
}

.status-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
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

.spin-icon {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.card-desc {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  margin: 0 0 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}

.card-tag {
  background: rgba(100, 116, 139, 0.1);
  color: var(--foreground-primary);
  border-color: rgba(100, 116, 139, 0.3);
  font-size: 10px;
}

.card-divider {
  height: 1px;
  background: var(--border-subtle);
  margin-bottom: 12px;
}

.card-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  text-align: center;
  margin-bottom: 12px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-value {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-bold);
  color: var(--foreground-primary);
}

.metric-label {
  font-size: 10px;
  color: var(--foreground-muted);
}

.card-configs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.config-badge {
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.config-icon {
  flex-shrink: 0;
}

.config-blue {
  background: rgba(59, 130, 246, 0.1);
  color: #93c5fd;
  border-color: rgba(59, 130, 246, 0.3);
}

.config-purple {
  background: rgba(139, 92, 246, 0.1);
  color: #c4b5fd;
  border-color: rgba(139, 92, 246, 0.3);
}

.config-amber {
  background: rgba(245, 158, 11, 0.1);
  color: #fcd34d;
  border-color: rgba(245, 158, 11, 0.3);
}

.config-green {
  background: rgba(16, 185, 129, 0.1);
  color: #6ee7b7;
  border-color: rgba(16, 185, 129, 0.3);
}
</style>
