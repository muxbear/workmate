/**
 * 定时任务（自动化）状态
 *
 * 数据来源为后端 /api/automation（按当前用户隔离），页面只做展示与交互。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '@/services/automationApi'
import type {
  AutomationRun,
  AutomationRunStats,
  AutomationTask,
  AutomationTaskDraft,
} from '@/types/automation'

export const useAutomationStore = defineStore('automation', () => {
  const tasks = ref<AutomationTask[]>([])
  const runs = ref<AutomationRun[]>([])
  const stats = ref<AutomationRunStats | null>(null)
  const loadingTasks = ref(false)
  const loadingRuns = ref(false)
  const error = ref('')

  /** 任务 id 到名称的映射，运行记录展示用 */
  const taskNameById = computed(() => {
    const map: Record<string, string> = {}
    for (const task of tasks.value) map[task.id] = task.title
    return map
  })

  /** 任务统计：总数 / 运行中 / 已暂停 */
  const taskStats = computed(() => ({
    total: tasks.value.length,
    enabled: tasks.value.filter((task) => task.enabled).length,
    paused: tasks.value.filter((task) => !task.enabled).length,
  }))

  /** 最近一次待触发任务（统计卡片展示） */
  const nextTask = computed(() => {
    const pending = tasks.value.filter((task) => task.enabled && task.nextRunAt !== null)
    if (pending.length === 0) return null
    return pending.reduce((earliest, task) =>
      (task.nextRunAt ?? 0) < (earliest.nextRunAt ?? 0) ? task : earliest,
    )
  })

  /** 拉取任务列表 */
  async function loadTasks(): Promise<void> {
    loadingTasks.value = true
    error.value = ''
    try {
      tasks.value = await api.fetchTasks()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载任务失败'
      throw err
    } finally {
      loadingTasks.value = false
    }
  }

  /** 拉取运行记录（默认 50 条） */
  async function loadRuns(opts?: {
    taskId?: string
    limit?: number
    cursor?: number
  }): Promise<void> {
    loadingRuns.value = true
    try {
      runs.value = await api.fetchRuns(opts)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载运行记录失败'
      throw err
    } finally {
      loadingRuns.value = false
    }
  }

  /** 分页加载更多运行记录（以最后一条 startedAt 为游标），返回本次条数 */
  async function loadMoreRuns(limit = 50): Promise<number> {
    const cursor = runs.value.length > 0 ? runs.value[runs.value.length - 1].startedAt : undefined
    const page = await api.fetchRuns({ limit, cursor })
    if (page.length > 0) runs.value = [...runs.value, ...page]
    return page.length
  }

  /** 运行结果详情（点击运行记录时加载完整输出） */
  async function loadRunDetail(id: string): Promise<AutomationRun> {
    const detail = await api.fetchRun(id)
    runs.value = runs.value.map((run) => (run.id === detail.id ? detail : run))
    return detail
  }

  /** 拉取运行统计 */
  async function loadStats(since?: number): Promise<void> {
    try {
      stats.value = await api.fetchRunStats(since)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载统计失败'
    }
  }

  /** 新建任务 */
  async function createTask(draft: AutomationTaskDraft): Promise<AutomationTask> {
    const created = await api.createTask(draft)
    tasks.value = [created, ...tasks.value.filter((task) => task.id !== created.id)]
    return created
  }

  /** 更新任务（原地替换，保持列表顺序） */
  async function updateTask(id: string, draft: AutomationTaskDraft): Promise<AutomationTask> {
    const updated = await api.updateTask(id, draft)
    tasks.value = tasks.value.map((task) => (task.id === updated.id ? updated : task))
    return updated
  }

  /** 删除任务 */
  async function deleteTask(id: string): Promise<void> {
    await api.deleteTask(id)
    tasks.value = tasks.value.filter((task) => task.id !== id)
  }

  /** 暂停 / 继续 */
  async function setEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
    const updated = await api.setTaskEnabled(id, enabled)
    tasks.value = tasks.value.map((task) => (task.id === updated.id ? updated : task))
    return updated
  }

  /** 立即运行（手动触发一次，保留原运行记录） */
  async function runNow(id: string): Promise<{ runId: string }> {
    const result = await api.runTaskNow(id)
    await loadTasks()
    return result
  }

  function reset(): void {
    tasks.value = []
    runs.value = []
    stats.value = null
    error.value = ''
  }

  return {
    tasks,
    runs,
    stats,
    loadingTasks,
    loadingRuns,
    error,
    taskNameById,
    taskStats,
    nextTask,
    loadTasks,
    loadRuns,
    loadMoreRuns,
    loadRunDetail,
    loadStats,
    createTask,
    updateTask,
    deleteTask,
    setEnabled,
    runNow,
    reset,
  }
})
