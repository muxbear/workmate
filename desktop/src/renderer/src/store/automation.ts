import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AutomationRun,
  AutomationRunStats,
  AutomationTask,
  AutomationTaskDraft,
  IpcResult
} from '../../../preload/index.d'

/** 解包 IPC 结果，失败直接抛错（页面统一 toast 展示） */
function unwrap<T>(res: IpcResult<T>): T {
  if (!res.success) throw new Error(res.error || '操作失败')
  return res.data as T
}

/**
 * 自动化任务与运行记录状态
 *
 * 数据来源全部是主进程（本地库按用户隔离），页面只做展示与交互。
 */
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

  /** 拉取任务列表 */
  async function loadTasks(): Promise<void> {
    loadingTasks.value = true
    error.value = ''
    try {
      tasks.value = unwrap(await window.api.automation.listTasks())
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
      runs.value = unwrap(await window.api.automation.listRuns(opts))
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载运行记录失败'
      throw err
    } finally {
      loadingRuns.value = false
    }
  }

  /** 拉取本周统计 */
  async function loadStats(since?: number): Promise<void> {
    try {
      stats.value = unwrap(await window.api.automation.runStats(since))
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载统计失败'
    }
  }

  /** 新建任务 */
  async function createTask(draft: AutomationTaskDraft): Promise<AutomationTask> {
    const created = unwrap(await window.api.automation.createTask(draft))
    tasks.value = [created, ...tasks.value.filter((task) => task.id !== created.id)]
    return created
  }

  /** 更新任务（原地替换，保持列表顺序） */
  async function updateTask(id: string, draft: AutomationTaskDraft): Promise<AutomationTask> {
    const updated = unwrap(await window.api.automation.updateTask(id, draft))
    tasks.value = tasks.value.map((task) => (task.id === updated.id ? updated : task))
    return updated
  }

  /** 删除任务（软删除，运行历史保留在主进程） */
  async function deleteTask(id: string): Promise<void> {
    unwrap(await window.api.automation.deleteTask(id))
    tasks.value = tasks.value.filter((task) => task.id !== id)
  }

  /** 暂停 / 继续 */
  async function setEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
    const updated = unwrap(await window.api.automation.setEnabled(id, enabled))
    tasks.value = tasks.value.map((task) => (task.id === updated.id ? updated : task))
    return updated
  }

  /** 立即运行（执行器接入后可用） */
  async function runNow(id: string): Promise<{ runId: string }> {
    const result = unwrap(await window.api.automation.runNow(id))
    await loadTasks()
    return result
  }

  /** 分页加载更多运行记录（以最后一条 started_at 为游标） */
  async function loadMoreRuns(limit = 50): Promise<number> {
    const cursor = runs.value.length > 0 ? runs.value[runs.value.length - 1].startedAt : undefined
    const page = unwrap(await window.api.automation.listRuns({ limit, cursor }))
    if (page.length > 0) runs.value = [...runs.value, ...page]
    return page.length
  }

  function subscribe(): () => void {
    const api = window.api && window.api.automation
    // 兼容旧版 preload（未暴露 onChanged 时静默跳过，不影响页面操作）
    if (!api || typeof api.onChanged !== 'function') return () => {}
    return api.onChanged((payload) => {
      void loadTasks().catch(() => {})
      if (payload.phase === 'finished') {
        void loadRuns({ limit: 50 }).catch(() => {})
        void loadStats().catch(() => {})
      }
    })
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
    loadTasks,
    loadRuns,
    loadMoreRuns,
    loadStats,
    createTask,
    updateTask,
    deleteTask,
    setEnabled,
    runNow,
    reset,
    subscribe
  }
})
