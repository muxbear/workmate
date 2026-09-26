<script setup lang="ts">
import { computed } from 'vue'
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Database, CheckCircle2, Loader2, CircleAlert, Pause,
  Sparkle, Scissors, Hash, Network,
  MoreVertical, Pin, PinOff, ArrowUp, ArrowDown, Pencil, Copy, Download, FolderInput,
} from 'lucide-vue-next'
import type { KB } from '@/types/knowledgeBase'
import { KB_STATUS_CONFIG, CHUNK_STRATEGY_OPTIONS } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { readApiError } from '@/services/knowledgeBaseApi'

const props = defineProps<{
  kb: KB
  /** 只读态（公共库 / 他人分享）：不展示组织操作 */
  readonly?: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const store = useKnowledgeBaseStore()
const groupDialogVisible = ref(false)
const busy = ref(false)

/** 只有库主能整理自己的列表（置顶/排序是"我的视图偏好"） */
const canOrganize = () => !props.readonly && props.kb.isOwner

async function run(label: string, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
  } catch (err: unknown) {
    ElMessage.error(`${label}失败：${readApiError(err)}`)
  } finally {
    busy.value = false
  }
}

function handleCommand(command: string) {
  switch (command) {
    case 'pin':
      void run(props.kb.isPinned ? '取消置顶' : '置顶', () =>
        store.togglePin(props.kb.id, !props.kb.isPinned))
      break
    case 'up':
      void run('上移', () => store.moveKb(props.kb.id, 'up'))
      break
    case 'down':
      void run('下移', () => store.moveKb(props.kb.id, 'down'))
      break
    case 'rename':
      void handleRename()
      break
    case 'copy':
      void run('复制', async () => {
        const created = await store.copyKb(props.kb.id)
        ElMessage.success(`已复制为《${created.name}》（只复制配置，文档需自行上传）`)
      })
      break
    case 'export':
      void run('导出', async () => {
        await store.exportKb(props.kb.id, props.kb.name)
        ElMessage.success('配置已导出')
      })
      break
    case 'group':
      groupDialogVisible.value = true
      break
  }
}

async function handleRename() {
  try {
    const { value } = await ElMessageBox.prompt('新的知识库名称', '重命名', {
      inputValue: props.kb.name,
      inputValidator: (v: string) => (v && v.trim() ? true : '名称不能为空'),
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    await run('重命名', () => store.updateKb(props.kb.id, { name: value.trim() }))
  } catch {
    // 用户取消
  }
}

async function handleAssignGroup(groupId: string | null) {
  groupDialogVisible.value = false
  await run('归组', () => store.assignGroup(props.kb.id, groupId))
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
          <Pin :size="12" />置顶
        </el-tag>
        <el-tag :class="['status-badge', statusCfg.cls]" size="small" disable-transitions>
          <component
            :is="statusIcon"
            :size="12"
            :class="{ 'spin-icon': kb.status === 'indexing' }"
          />
          {{ statusCfg.label }}
        </el-tag>
        <el-dropdown v-if="canOrganize()" trigger="click" @command="handleCommand">
          <button class="card-menu-btn" :disabled="busy" title="更多操作" aria-label="更多操作">
            <MoreVertical :size="16" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pin">
                <PinOff v-if="kb.isPinned" :size="14" /><Pin v-else :size="14" />
                {{ kb.isPinned ? '取消置顶' : '置顶' }}
              </el-dropdown-item>
              <el-dropdown-item command="up"><ArrowUp :size="14" />上移</el-dropdown-item>
              <el-dropdown-item command="down"><ArrowDown :size="14" />下移</el-dropdown-item>
              <el-dropdown-item command="rename" divided><Pencil :size="14" />重命名</el-dropdown-item>
              <el-dropdown-item command="copy"><Copy :size="14" />复制（含配置）</el-dropdown-item>
              <el-dropdown-item command="export"><Download :size="14" />导出配置</el-dropdown-item>
              <el-dropdown-item command="group"><FolderInput :size="14" />归入分组…</el-dropdown-item>
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
        <span class="metric-label">文档</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.chunks) }}</span>
        <span class="metric-label">分片</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.entities) }}</span>
        <span class="metric-label">实体</span>
      </div>
      <div class="metric">
        <span class="metric-value">{{ metricFormat(kb.relations) }}</span>
        <span class="metric-label">关系</span>
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
        <Network :size="10" class="config-icon" />知识图谱
      </el-tag>
    </div>
    <!-- 归入分组：列出本人在册的分组 + "移出分组" -->
    <el-dialog
      v-model="groupDialogVisible"
      title="归入分组"
      width="360px"
      append-to-body
      @click.stop
    >
      <div class="group-picker">
        <button class="group-pick-item" @click="handleAssignGroup(null)">
          不归入任何分组
          <span v-if="!kb.groupId" class="group-pick-current">当前</span>
        </button>
        <button
          v-for="g in store.kbGroups"
          :key="g.id"
          class="group-pick-item"
          @click="handleAssignGroup(g.id)"
        >
          {{ g.name }}
          <span v-if="kb.groupId === g.id" class="group-pick-current">当前</span>
        </button>
        <div v-if="store.kbGroups.length === 0" class="group-pick-empty">
          还没有分组——在知识库页的筛选栏里新建
        </div>
      </div>
    </el-dialog>
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

.group-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-pick-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}

.group-pick-current {
  font-size: var(--font-size-xs, 12px);
  color: var(--el-color-primary, #409eff);
}

.group-pick-empty {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  padding: 8px 0;
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
