<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { showToast as showToastBase } from '@renderer/composables/useToast'
import ConfirmDialog from '@components/ConfirmDialog.vue'
import { useAutomationStore } from '@store/automation'
import { useAutomationTemplateSyncStore } from '@store/automationTemplateSync'
import type {
  AutomationSchedule,
  AutomationTaskDraft,
  DesktopAutomationTemplate
} from '../../../preload/index.d'

const automation = useAutomationStore()
const templateSync = useAutomationTemplateSyncStore()

/** 待删除模板（删除确认弹窗依据；取消/确认后置空） */
const pendingDelete = ref<DesktopAutomationTemplate | null>(null)

/** 操作提示：全局 toast（沿用历史 2.2s 时长） */
const showToast = (text: string): void => showToastBase(text, 2200)

/** 已添加过的模板 id 集合：任务的 templateId 即模板 id（UUID 字符串） */
const addedTemplateIds = computed(
  () => new Set(automation.tasks.map((task) => task.templateId).filter((id) => !!id))
)

const isAdded = (tpl: DesktopAutomationTemplate): boolean => addedTemplateIds.value.has(tpl.id)

/** 上次同步时间文案（未同步过则不显示） */
const lastSyncedText = computed(() => {
  if (!templateSync.lastSyncedAt) return ''
  return new Date(templateSync.lastSyncedAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
})

/** 本地日期（YYYY-MM-DD），offsetDays 为相对今天的天数 */
const localDate = (offsetDays = 0): string => {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 模板 → 任务草稿（与 Web 端 toTaskDraft 同口径）。
 *
 * 「单次」模板要特别处理：模板本身不参与调度，里面那个日期只是占位，
 * 建任务时必须换成**当天**，否则会生成一个日期已经过去的任务。
 */
function toTaskDraft(tpl: DesktopAutomationTemplate): AutomationTaskDraft {
  const schedule: AutomationSchedule = {
    ...tpl.schedule,
    weekDays: [...tpl.schedule.weekDays],
    weekIntervalDays: [...tpl.schedule.weekIntervalDays]
  }
  if (schedule.freqGroup === 'cycle' && schedule.cycleKind === 'once') {
    schedule.onceDate = localDate()
  }

  const promptText = tpl.promptText || tpl.description
  return {
    title: tpl.name,
    promptText,
    promptParts:
      tpl.promptParts.length > 0 ? tpl.promptParts : [{ type: 'text', text: promptText }],
    icon: tpl.icon,
    source: 'template',
    templateId: tpl.id,
    schedule,
    model: tpl.model,
    customModelId: tpl.customModelId,
    expertId: tpl.expertId,
    expertName: tpl.expertName,
    contextMode: tpl.contextMode,
    skillIds: [...tpl.skillIds],
    workspaceId: tpl.workspaceId,
    workspaceName: tpl.workspaceName,
    fullAccess: tpl.fullAccess
  }
}

/** 模板快捷添加：落库为一条本地定时任务（source 记为 template，便于回显已添加状态） */
const addTask = async (tpl: DesktopAutomationTemplate): Promise<void> => {
  if (isAdded(tpl)) return
  try {
    await automation.createTask(toTaskDraft(tpl))
    await automation.loadStats()
    showToast(`已添加任务「${tpl.name}」`)
  } catch (err) {
    automation.error = err instanceof Error ? err.message : '添加失败'
  }
}

/** 打开删除确认（仅本机删除，服务端仍存在则下次同步会重新拉回） */
const askDelete = (tpl: DesktopAutomationTemplate): void => {
  pendingDelete.value = tpl
}

const cancelDelete = (): void => {
  pendingDelete.value = null
}

const confirmDelete = async (): Promise<void> => {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (!target) return
  const ok = await templateSync.removeTemplate(target.id)
  showToast(ok ? `模板「${target.name}」已删除` : (templateSync.error ?? '删除模板失败'))
}

/** 手动同步（首次会走一次浏览器授权） */
async function handleSync(): Promise<void> {
  const ok = await templateSync.sync()
  if (!ok) {
    showToast(templateSync.error ?? '同步失败')
    return
  }
  const stats = templateSync.stats
  showToast(
    stats
      ? `同步完成：新增 ${stats.added} 个，更新 ${stats.updated} 个，保留本地 ${stats.kept} 个`
      : '定时模板同步完成'
  )
}

/** 挂载：先展示本地 templates.json 数据，再读取同步状态（不自动触发网络同步） */
onMounted(() => {
  void templateSync.loadStatus()
  void templateSync.loadLocal()
  // 「已添加」判据依赖任务列表，模板页单独进入时也要拉一次
  void automation.loadTasks().catch(() => {})
})
</script>

<template>
  <div class="auto-page">
    <!-- 工具栏：标题 + 上次同步时间 + 手动同步 -->
    <div class="tpl-header">
      <div class="tpl-header-main">
        <h2 class="sec-title">定时模板</h2>
        <span v-if="lastSyncedText" class="tpl-synced">上次同步：{{ lastSyncedText }}</span>
      </div>
      <button class="sync-btn" :disabled="templateSync.syncing" @click="handleSync">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        {{ templateSync.syncing ? '同步中…' : '同步模板' }}
      </button>
    </div>

    <Transition name="sync-fade">
      <div v-if="templateSync.syncing" class="sync-progress">
        <div class="sync-progress-bar">
          <div class="sync-progress-fill" :style="{ width: templateSync.percent + '%' }" />
        </div>
        <span class="sync-progress-text">
          {{ templateSync.progressMessage }} {{ templateSync.percent }}%
        </span>
      </div>
    </Transition>
    <div v-if="templateSync.error" class="sync-error">{{ templateSync.error }}</div>

    <div class="auto-body">
      <!-- 尚未同步过：引导手动同步 -->
      <div v-if="!templateSync.loaded" class="empty-state">
        <div class="empty-icon-circle">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect
              x="6"
              y="7"
              width="20"
              height="18"
              rx="3"
              stroke="rgba(8,145,178,0.35)"
              stroke-width="1.8"
            />
            <line x1="6" y1="13" x2="26" y2="13" stroke="rgba(8,145,178,0.3)" stroke-width="1.8" />
            <line
              x1="12"
              y1="18"
              x2="20"
              y2="18"
              stroke="rgba(8,145,178,0.4)"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <p class="empty-title">还没有同步过定时模板</p>
        <p class="empty-desc">点右上角「同步模板」把 Web 端的模板拉到本机，之后可随时离线查看</p>
      </div>

      <!-- 同步过但服务端没有模板 -->
      <div v-else-if="templateSync.templates.length === 0" class="empty-state">
        <p class="empty-title">服务端暂无定时模板</p>
        <p class="empty-desc">等 Web 端「定时模板」页添加模板后，重新同步即可</p>
      </div>

      <!-- 模板网格 -->
      <div v-else class="tpl-section">
        <div class="task-grid">
          <div
            v-for="tpl in templateSync.templates"
            :key="tpl.id"
            :class="['task-card', 'task-card--tpl', { 'task-card--added': isAdded(tpl) }]"
          >
            <span class="task-icon">{{ tpl.icon }}</span>
            <div class="task-info">
              <p class="task-name">{{ tpl.name }}</p>
              <p class="task-desc">{{ tpl.description || tpl.promptText }}</p>
              <div class="task-foot">
                <span class="task-freq">{{ tpl.freqSummary }}</span>
                <div class="tpl-actions">
                  <button
                    :class="['task-add-btn', { 'task-add-btn--added': isAdded(tpl) }]"
                    @click="addTask(tpl)"
                  >
                    {{ isAdded(tpl) ? '✓ 已添加' : '+ 添加' }}
                  </button>
                  <button
                    class="tpl-del-btn"
                    title="删除模板（仅本机）"
                    :disabled="templateSync.removingId === tpl.id"
                    @click="askDelete(tpl)"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认：仅删本机副本，服务端仍存在时下次同步会重新拉回 -->
    <ConfirmDialog
      v-if="pendingDelete"
      title="删除模板"
      :message="
        '确定删除模板「' +
        pendingDelete.name +
        '」吗？此操作仅从本机移除；若服务端仍存在该模板，下次重新同步会再次出现。'
      "
      confirm-text="删除"
      cancel-text="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

  </div>
</template>

<style scoped>
.auto-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kw-color-surface);
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
}

.tpl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}
.tpl-header-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.tpl-synced {
  font-size: 11px;
  color: var(--kw-color-text-faint);
}

.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}

.sync-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 8px;
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.25);
}
.sync-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.auto-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}
.auto-body::-webkit-scrollbar {
  display: none;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 20px;
  text-align: center;
}
.empty-icon-circle {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--kw-color-brand-hover);
  margin-bottom: 14px;
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0 0 6px;
}
.empty-desc {
  font-size: 12px;
  color: var(--kw-color-text-secondary);
  margin: 0;
  max-width: 360px;
  line-height: 1.6;
}

.tpl-section {
  margin-top: 20px;
  padding-bottom: 32px;
}
.task-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  padding: 0 24px;
}
.task-card {
  display: flex;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
}
.task-card--tpl {
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.task-card--tpl:hover {
  border-color: rgba(8, 145, 178, 0.22);
  background: var(--kw-color-surface);
}
.task-card--added {
  background: var(--kw-color-brand-hover);
  border-color: rgba(8, 145, 178, 0.25);
}
.task-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 2px;
}
.task-info {
  flex: 1;
  min-width: 0;
}
.task-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0 0 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-desc {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  line-height: 1.4;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.task-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.task-freq {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tpl-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.task-add-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.task-add-btn--added {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}
/* 删除按钮：悬浮或键盘聚焦时显现，静止时保持卡片简洁 */
.tpl-del-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s,
    background 0.15s,
    color 0.15s;
}
.task-card--tpl:hover .tpl-del-btn,
.tpl-del-btn:focus-visible {
  opacity: 1;
}
.tpl-del-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  color: var(--kw-color-danger);
}
.tpl-del-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sync-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--kw-color-surface-soft);
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}
.sync-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--kw-color-bg-muted, #eff1f1);
  overflow: hidden;
}
.sync-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--kw-color-brand);
  transition: width 0.2s ease;
}
.sync-progress-text {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  white-space: nowrap;
}
.sync-error {
  padding: 8px 24px;
  font-size: 12px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.06);
  border-bottom: 1px solid rgba(220, 38, 38, 0.12);
}
.sync-fade-enter-active,
.sync-fade-leave-active {
  transition: opacity 0.2s ease;
}
.sync-fade-enter-from,
.sync-fade-leave-to {
  opacity: 0;
}

@media (max-width: 1024px) {
  .task-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 768px) {
  .task-grid {
    grid-template-columns: 1fr;
  }
}
</style>
