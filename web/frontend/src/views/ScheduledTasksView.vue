<script setup lang="ts">
/**
 * 定时任务页面（对齐桌面版「自动化」菜单）
 *
 * 两个页签：「定时任务」展示我的任务与任务模版，「运行记录」展示执行历史与本周统计。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Pencil, Pause, Play, Plus, RefreshCw, Search, Trash2, X, Zap } from 'lucide-vue-next'
import AutomationTaskDialog from '@/components/automation/AutomationTaskDialog.vue'
import { useAutomationStore } from '@/stores/automation'
import {
  AUTOMATION_TEMPLATES,
  RUN_STATUS_META,
  RUN_TRIGGER_LABEL,
  TASK_STATUS_META,
} from '@/types/automation'
import type { AutomationRun, AutomationTask } from '@/types/automation'

type Tab = 'tasks' | 'logs'

const automation = useAutomationStore()

const tab = ref<Tab>('tasks')
const refreshing = ref(false)
const loadingMore = ref(false)
const hasMoreRuns = ref(true)
const showDialog = ref(false)
const editingTask = ref<AutomationTask | null>(null)
const runDetail = ref<AutomationRun | null>(null)
const keyword = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

/** 任务列表：按名称 / 提示词过滤 */
const myTasks = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return automation.tasks
  return automation.tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(text) || task.promptText.toLowerCase().includes(text),
  )
})

/** 已添加的模版 id 集合，模版卡片据此显示「已添加」 */
const addedTemplateIds = computed(
  () => new Set(automation.tasks.map((task) => task.templateId).filter(Boolean) as string[]),
)

/** 运行记录展示行 */
const runRows = computed(() =>
  automation.runs.map((run) => {
    const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.running
    return {
      id: run.id,
      taskId: run.taskId,
      name: automation.taskNameById[run.taskId] ?? '已删除的任务',
      status: run.status,
      statusLabel: meta.label,
      color: meta.color,
      trigger: RUN_TRIGGER_LABEL[run.trigger] ?? '定时触发',
      time: formatRunTime(run.startedAt),
      duration: formatDuration(run.durationMs),
      reason: run.errorMessage ?? '',
    }
  }),
)

/** 本周统计卡片 */
const statsCards = computed(() => {
  const current = automation.stats
  const total = current?.total ?? 0
  const success = current?.success ?? 0
  const failed = current?.failed ?? 0
  const skipped = current?.skipped ?? 0
  const rate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0
  return [
    {
      label: '本周运行次数',
      value: String(total),
      sub: '成功 ' + success + ' 次 / 失败 ' + failed + ' 次',
      color: '#22d3ee',
    },
    {
      label: '成功率',
      value: rate + '%',
      sub: total > 0 ? '按全部运行统计' : '暂无数据',
      color: '#6ee7b7',
    },
    {
      label: '平均耗时',
      value: formatDuration(current?.avgDurationMs ?? null),
      sub: skipped > 0 ? '跳过 ' + skipped + ' 次' : '按已完成运行统计',
      color: '#fbbf24',
    },
  ]
})

/** 时间文案：今天 08:00 / 昨天 20:30 / 9月18日 08:00 */
function formatRunTime(ts: number | null): string {
  if (ts == null) return '-'
  const date = new Date(ts)
  const now = new Date()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) return '今天 ' + hh + ':' + mm
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + hh + ':' + mm
  return String(date.getMonth() + 1) + '月' + date.getDate() + '日 ' + hh + ':' + mm
}

/** 耗时文案 */
function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

/** 任务排期文案 */
function formatNextRun(task: AutomationTask): string {
  if (!task.enabled) return '已暂停'
  if (task.status === 'expired') return '已过期'
  if (task.status === 'finished') return '已完成'
  if (task.nextRunAt == null) return '未排期'
  return '下次 ' + formatRunTime(task.nextRunAt)
}

/** 任务状态元信息（暂停优先展示） */
function taskStatusKey(task: AutomationTask): keyof typeof TASK_STATUS_META {
  if (!task.enabled) return 'paused'
  if (task.status === 'expired') return 'expired'
  if (task.status === 'finished') return 'finished'
  return 'enabled'
}

/** 产物文案（后端 artifacts 条目） */
function artifactLabel(item: Record<string, unknown>): string {
  const name = typeof item.name === 'string' ? item.name : ''
  const path = typeof item.path === 'string' ? item.path : ''
  return name || path || '未命名产物'
}

async function loadAll(): Promise<void> {
  try {
    await automation.loadTasks()
    await Promise.all([automation.loadRuns({ limit: 50 }), automation.loadStats()])
    hasMoreRuns.value = automation.runs.length >= 50
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载定时任务失败')
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

function openCreate(): void {
  editingTask.value = null
  showDialog.value = true
}

function openEdit(task: AutomationTask): void {
  editingTask.value = task
  showDialog.value = true
}

function closeDialog(): void {
  showDialog.value = false
  editingTask.value = null
}

async function handleDialogSaved(): Promise<void> {
  closeDialog()
}

/** 模版快捷添加：落库并标记为模版来源，便于回显「已添加」 */
async function addTemplate(templateId: number): Promise<void> {
  const template = AUTOMATION_TEMPLATES.find((item) => item.id === templateId)
  if (!template || addedTemplateIds.value.has(String(template.id))) return
  try {
    await automation.createTask({
      title: template.title,
      promptText: template.desc,
      promptParts: [{ type: 'text', text: template.desc }],
      icon: template.icon,
      source: 'template',
      templateId: String(template.id),
      schedule: template.schedule,
      model: null,
      customModelId: null,
      providerId: null,
      modelId: null,
      expertId: null,
      expertName: null,
      contextMode: 'default',
      skillIds: [],
      kbIds: [],
      workspaceId: null,
      workspaceName: null,
      allowNetwork: false,
      allowShell: false,
      fullAccess: false,
    })
    await automation.loadStats()
    ElMessage.success('已添加「' + template.title + '」')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '添加失败')
  }
}

async function handleToggle(task: AutomationTask): Promise<void> {
  try {
    await automation.setEnabled(task.id, !task.enabled)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function handleRunNow(task: AutomationTask): Promise<void> {
  try {
    await automation.runNow(task.id)
    ElMessage.success('已开始运行「' + task.title + '」')
    setTimeout(() => {
      void automation.loadRuns({ limit: 50 })
    }, 1500)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '运行失败')
  }
}

async function handleDelete(task: AutomationTask): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '确定要删除「' + task.title + '」吗？删除后无法恢复。',
      '删除自动化任务',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  try {
    await automation.deleteTask(task.id)
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

async function loadMoreRuns(): Promise<void> {
  if (loadingMore.value) return
  loadingMore.value = true
  try {
    const got = await automation.loadMoreRuns(50)
    if (got < 50) hasMoreRuns.value = false
  } catch {
    hasMoreRuns.value = false
  } finally {
    loadingMore.value = false
  }
}

async function openRunDetail(id: string): Promise<void> {
  try {
    runDetail.value = await automation.loadRunDetail(id)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载运行结果失败')
  }
}

async function retryRun(taskId: string): Promise<void> {
  try {
    await automation.runNow(taskId)
    ElMessage.success('已重新触发运行')
    setTimeout(() => {
      void automation.loadRuns({ limit: 50 })
    }, 1500)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重试失败')
  }
}

onMounted(() => {
  void loadAll()
  // 后台调度没有推送通道，运行中时每 5 秒刷新一次记录与统计。
  refreshTimer = setInterval(() => {
    if (automation.runs.some((run) => run.status === 'running')) {
      void Promise.all([automation.loadRuns({ limit: 50 }), automation.loadStats()])
    }
  }, 5000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
<template>
  <div class="auto-page">
    <div class="auto-header">
      <div>
        <h1 class="auto-title">定时任务</h1>
        <p class="auto-subtitle">按计划唤醒智能体，自动完成重复工作</p>
      </div>
      <div class="auto-header-actions">
        <button class="auto-btn auto-btn--ghost" @click="handleRefresh">
          <RefreshCw :size="14" :class="{ spinning: refreshing }" />
          刷新
        </button>
        <button class="auto-btn auto-btn--primary" @click="openCreate">
          <Plus :size="15" />
          新建任务
        </button>
      </div>
    </div>

    <p v-if="automation.error" class="auto-error">{{ automation.error }}</p>

    <div class="auto-tabs">
      <button
        v-for="item in [
          ['tasks', '定时任务'],
          ['logs', '运行记录'],
        ] as const"
        :key="item[0]"
        class="auto-tab"
        :class="{ 'auto-tab--active': tab === item[0] }"
        @click="tab = item[0]"
      >
        {{ item[1] }}
      </button>
    </div>

    <!-- 定时任务 -->
    <div v-if="tab === 'tasks'" class="auto-body">
      <div v-if="automation.tasks.length === 0" class="auto-empty">
        <div class="auto-empty-icon">⏰</div>
        <p class="auto-empty-title">开启你的第一个自动化任务吧</p>
        <p class="auto-empty-desc">从模版选择或自定义定时任务，让智能体自动帮你完成重复工作</p>
        <button class="auto-btn auto-btn--primary" @click="openCreate">
          <Plus :size="15" />
          添加自动化
        </button>
      </div>

      <template v-else>
        <div class="auto-section-head">
          <h2 class="auto-section-title">
            我的任务 <span class="auto-count">{{ automation.tasks.length }} 个</span>
          </h2>
          <div class="auto-section-tools">
            <div class="auto-search">
              <Search :size="13" />
              <input v-model="keyword" type="text" placeholder="搜索任务名称或提示词" />
            </div>
            <button class="auto-btn auto-btn--primary auto-btn--sm" @click="openCreate">
              <Plus :size="13" />
              添加自动化
            </button>
          </div>
        </div>

        <div v-if="myTasks.length === 0" class="auto-empty auto-empty--sm">
          <p class="auto-empty-desc">没有匹配的任务，试试其他关键词。</p>
        </div>

        <div class="auto-grid">
          <div v-for="task in myTasks" :key="task.id" class="auto-card">
            <span class="auto-card-icon">{{ task.icon }}</span>
            <div class="auto-card-main">
              <p class="auto-card-title">{{ task.title }}</p>
              <p class="auto-card-desc">{{ task.promptText }}</p>
              <div class="auto-card-meta">
                <span class="auto-meta-freq">{{ task.freqSummary }}</span>
                <span class="auto-meta">{{ task.validitySummary }}</span>
                <span class="auto-meta">{{ formatNextRun(task) }}</span>
                <span v-if="task.runCount > 0" class="auto-meta">
                  运行 {{ task.runCount }} 次 / 失败 {{ task.failCount }} 次
                </span>
              </div>
              <div class="auto-card-foot">
                <span
                  class="auto-status"
                  :style="{
                    color: TASK_STATUS_META[taskStatusKey(task)].color,
                    background: TASK_STATUS_META[taskStatusKey(task)].bg,
                  }"
                >
                  <span
                    class="auto-status-dot"
                    :style="{ background: TASK_STATUS_META[taskStatusKey(task)].dot }"
                  />
                  {{ TASK_STATUS_META[taskStatusKey(task)].label }}
                </span>
                <div class="auto-card-actions">
                  <button class="auto-icon-btn" title="立即运行" @click="handleRunNow(task)" aria-label="立即运行">
                    <Zap :size="13" />
                  </button>
                  <button
                    class="auto-icon-btn"
                    :title="task.enabled ? '暂停' : '继续'"
                    @click="handleToggle(task)"
                   :aria-label="task.enabled ? '暂停' : '继续'">
                    <Pause v-if="task.enabled" :size="13" />
                    <Play v-else :size="13" />
                  </button>
                  <button class="auto-icon-btn" title="编辑" @click="openEdit(task)" aria-label="编辑">
                    <Pencil :size="13" />
                  </button>
                  <button
                    class="auto-icon-btn auto-icon-btn--danger"
                    title="删除"
                    @click="handleDelete(task)"
                   aria-label="删除">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div class="auto-section-head auto-section-head--tpl">
        <h2 class="auto-section-title">自动化任务模版</h2>
      </div>
      <div class="auto-grid">
        <div
          v-for="template in AUTOMATION_TEMPLATES"
          :key="template.id"
          class="auto-card auto-card--template"
          :class="{ 'auto-card--added': addedTemplateIds.has(String(template.id)) }"
        >
          <span class="auto-card-icon">{{ template.icon }}</span>
          <div class="auto-card-main">
            <p class="auto-card-title">{{ template.title }}</p>
            <p class="auto-card-desc">{{ template.desc }}</p>
            <div class="auto-card-foot">
              <span class="auto-meta-freq">{{ template.freq }}</span>
              <button
                class="auto-btn auto-btn--sm"
                :class="
                  addedTemplateIds.has(String(template.id))
                    ? 'auto-btn--ghost'
                    : 'auto-btn--primary'
                "
                :disabled="addedTemplateIds.has(String(template.id))"
                @click="addTemplate(template.id)"
              >
                {{ addedTemplateIds.has(String(template.id)) ? '✓ 已添加' : '+ 添加' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- 运行记录 -->
    <div v-else class="auto-body">
      <div class="auto-section-head">
        <h2 class="auto-section-title">
          运行记录 <span class="auto-count">已加载 {{ runRows.length }} 条</span>
        </h2>
        <button
          v-if="hasMoreRuns"
          class="auto-btn auto-btn--ghost auto-btn--sm"
          :disabled="loadingMore"
          @click="loadMoreRuns"
        >
          {{ loadingMore ? '加载中…' : '加载更多' }}
        </button>
      </div>

      <div class="auto-table">
        <div class="auto-table-head">
          <span>任务名称</span>
          <span>运行时间</span>
          <span>耗时</span>
          <span>状态</span>
          <span class="auto-col-right">操作</span>
        </div>
        <div
          v-for="row in runRows"
          :key="row.id"
          class="auto-table-row"
          @click="openRunDetail(row.id)"
        >
          <span class="auto-cell-name">{{ row.name }}</span>
          <span class="auto-cell-mono">{{ row.time }}</span>
          <span class="auto-cell-mono">{{ row.duration }}</span>
          <div class="auto-cell-status">
            <span class="auto-status-dot" :style="{ background: row.color }" />
            <span :style="{ color: row.color }">{{ row.statusLabel }}</span>
            <span class="auto-cell-trigger">{{ row.trigger }}</span>
            <span v-if="row.reason" class="auto-cell-reason" :title="row.reason">{{
              row.reason
            }}</span>
          </div>
          <div class="auto-cell-actions" @click.stop>
            <button class="auto-btn auto-btn--ghost auto-btn--sm" @click="openRunDetail(row.id)">
              结果
            </button>
            <button
              v-if="row.status === 'failed'"
              class="auto-btn auto-btn--ghost auto-btn--sm"
              @click="retryRun(row.taskId)"
            >
              重试
            </button>
          </div>
        </div>
        <p v-if="runRows.length === 0" class="auto-empty-desc auto-empty-desc--center">
          暂无运行记录，创建任务并等待触发后这里会显示结果。
        </p>
      </div>

      <div class="auto-stats">
        <div v-for="stat in statsCards" :key="stat.label" class="auto-stat-card">
          <p class="auto-stat-label">{{ stat.label }}</p>
          <p class="auto-stat-value" :style="{ color: stat.color }">{{ stat.value }}</p>
          <p class="auto-stat-sub">{{ stat.sub }}</p>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑任务 -->
    <AutomationTaskDialog
      v-if="showDialog"
      :task="editingTask"
      @close="closeDialog"
      @saved="handleDialogSaved"
    />

    <!-- 运行结果详情 -->
    <div v-if="runDetail" class="auto-mask" @click.self="runDetail = null">
      <div class="auto-dialog">
        <div class="auto-dialog-head">
          <p class="auto-dialog-title">运行结果</p>
          <button class="auto-icon-btn" title="关闭" @click="runDetail = null" aria-label="关闭">
            <X :size="15" />
          </button>
        </div>
        <div class="auto-dialog-body">
          <div class="auto-dialog-meta">
            <span :style="{ color: RUN_STATUS_META[runDetail.status].color }">
              {{ RUN_STATUS_META[runDetail.status].label }}
            </span>
            <span>触发：{{ RUN_TRIGGER_LABEL[runDetail.trigger] }}</span>
            <span>开始：{{ formatRunTime(runDetail.startedAt) }}</span>
            <span>耗时：{{ formatDuration(runDetail.durationMs) }}</span>
            <span v-if="runDetail.model">模型：{{ runDetail.model }}</span>
          </div>
          <p v-if="runDetail.errorMessage" class="auto-dialog-error">
            失败原因：{{ runDetail.errorMessage }}
          </p>
          <pre v-if="runDetail.outputText" class="auto-dialog-output">{{
            runDetail.outputText
          }}</pre>
          <p v-else-if="!runDetail.errorMessage" class="auto-empty-desc">本次运行没有输出内容。</p>
          <div v-if="runDetail.artifacts.length > 0" class="auto-artifacts">
            <p class="auto-artifacts-title">产出文件</p>
            <p v-for="(item, index) in runDetail.artifacts" :key="index" class="auto-artifact">
              {{ artifactLabel(item) }}
            </p>
          </div>
        </div>
        <div class="auto-dialog-foot">
          <button class="auto-btn auto-btn--ghost" @click="runDetail = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.auto-page {
  height: 100%;
  overflow-y: auto;
  padding: 24px;
  background: var(--surface-primary);
}

.auto-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.auto-title {
  font-size: 26px;
  font-weight: var(--font-weight-bold);
  color: var(--foreground-primary);
}

.auto-subtitle {
  margin-top: 4px;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.auto-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.auto-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}

.auto-btn--ghost {
  border-color: var(--border-medium);
  background: var(--surface-card);
  color: var(--foreground-secondary);
}

.auto-btn--ghost:hover:not(:disabled) {
  color: var(--foreground-primary);
  background: var(--surface-secondary);
}

.auto-btn--primary {
  background: var(--accent-primary);
  color: #fff;
  box-shadow: var(--shadow-button);
}

.auto-btn--primary:hover:not(:disabled) {
  background: var(--color-accent-dark);
}

.auto-btn--sm {
  padding: 5px 10px;
  font-size: var(--font-size-xs);
}

.auto-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.spinning {
  animation: auto-spin 1s linear infinite;
}

@keyframes auto-spin {
  to {
    transform: rotate(360deg);
  }
}

.auto-error {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: var(--radius-lg);
  background: rgba(248, 113, 113, 0.1);
  color: #f87171;
  font-size: var(--font-size-xs);
}

.auto-tabs {
  display: flex;
  gap: 18px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.auto-tab {
  position: relative;
  padding: 8px 2px 10px;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-md);
  cursor: pointer;
}

.auto-tab--active {
  color: var(--foreground-primary);
  font-weight: var(--font-weight-medium);
}

.auto-tab--active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent-primary);
}

.auto-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auto-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.auto-section-head--tpl {
  margin-top: 8px;
}

.auto-section-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.auto-count {
  margin-left: 6px;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--foreground-muted);
}

.auto-section-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.auto-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: var(--surface-card);
  color: var(--foreground-muted);
}

.auto-search input {
  width: 200px;
  border: none;
  background: transparent;
  outline: none;
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
}

.auto-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 56px 16px;
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  text-align: center;
}

.auto-empty--sm {
  padding: 28px 16px;
}

.auto-empty-icon {
  font-size: 32px;
}

.auto-empty-title {
  font-size: var(--font-size-md);
  color: var(--foreground-primary);
}

.auto-empty-desc {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-empty-desc--center {
  padding: 32px 16px;
  text-align: center;
}

.auto-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.auto-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  transition: border-color 0.15s ease;
}

.auto-card:hover {
  border-color: var(--border-medium);
}

.auto-card--added {
  opacity: 0.72;
}

.auto-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  font-size: 18px;
  flex-shrink: 0;
}

.auto-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.auto-card-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-primary);
}

.auto-card-desc {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--foreground-muted);
}

.auto-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-meta-freq {
  color: #67e8f9;
}

.auto-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 2px;
}

.auto-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
}

.auto-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.auto-card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.auto-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.auto-icon-btn:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.auto-icon-btn--danger:hover {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
}
.auto-table {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  overflow: hidden;
}

.auto-table-head,
.auto-table-row {
  display: grid;
  grid-template-columns: 1.6fr 1fr 0.7fr 1.6fr 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px 16px;
}

.auto-table-head {
  border-bottom: 1px solid var(--border-subtle);
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.auto-table-row {
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: background 0.12s ease;
}

.auto-table-row:last-child {
  border-bottom: none;
}

.auto-table-row:hover {
  background: var(--surface-secondary);
}

.auto-cell-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.auto-cell-mono {
  font-family: 'Courier New', monospace;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-cell-status {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--font-size-xs);
}

.auto-cell-trigger {
  color: var(--foreground-muted);
}

.auto-cell-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #f87171;
}

.auto-cell-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.auto-col-right {
  text-align: right;
}

.auto-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.auto-stat-card {
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  background: var(--surface-card);
}

.auto-stat-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-stat-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: var(--font-weight-bold);
}

.auto-stat-sub {
  margin-top: 4px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-mask {
  position: fixed;
  inset: 0;
  z-index: 880;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--color-overlay);
  backdrop-filter: blur(3px);
}

.auto-dialog {
  width: 100%;
  max-width: 560px;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  background: var(--color-modal-bg);
  box-shadow: var(--shadow-modal);
}

.auto-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.auto-dialog-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.auto-dialog-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  overflow-y: auto;
}

.auto-dialog-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
}

.auto-dialog-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: var(--radius-lg);
  background: rgba(248, 113, 113, 0.08);
  color: #f87171;
  font-size: var(--font-size-xs);
}

.auto-dialog-output {
  margin: 0;
  padding: 12px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-family: 'Courier New', monospace;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.auto-artifacts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.auto-artifacts-title {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.auto-artifact {
  margin: 0;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
}

.auto-dialog-foot {
  display: flex;
  justify-content: flex-end;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border-subtle);
}

@media (max-width: 900px) {
  .auto-table-head,
  .auto-table-row {
    grid-template-columns: 1.4fr 1fr 0.8fr 1.2fr 1fr;
  }

  .auto-search input {
    width: 120px;
  }
}
</style>
