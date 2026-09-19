/**
 * 定时任务（自动化）接口 — 后端 /api/automation
 *
 * 与桌面版自动化 IPC 通道一一对应：任务 CRUD、暂停/继续、立即运行、运行记录与统计。
 */
import instance from './request'
import type {
  AutomationRun,
  AutomationRunStats,
  AutomationTask,
  AutomationTaskDraft,
} from '@/types/automation'

/** 任务列表（按创建时间倒序，后端已按当前用户隔离） */
export async function fetchTasks(): Promise<AutomationTask[]> {
  const res = await instance.get('/automation/tasks')
  return (res.data.data ?? []) as AutomationTask[]
}

/** 单个任务（编辑回填） */
export async function fetchTask(id: string): Promise<AutomationTask> {
  const res = await instance.get('/automation/tasks/' + encodeURIComponent(id))
  return res.data.data as AutomationTask
}

/** 新建任务 */
export async function createTask(draft: AutomationTaskDraft): Promise<AutomationTask> {
  const res = await instance.post('/automation/tasks', draft)
  return res.data.data as AutomationTask
}

/** 更新任务（后端会重算排期） */
export async function updateTask(id: string, draft: AutomationTaskDraft): Promise<AutomationTask> {
  const res = await instance.put('/automation/tasks/' + encodeURIComponent(id), draft)
  return res.data.data as AutomationTask
}

/** 删除任务（软删除，运行历史保留） */
export async function deleteTask(id: string): Promise<void> {
  await instance.delete('/automation/tasks/' + encodeURIComponent(id))
}

/** 暂停 / 继续任务 */
export async function setTaskEnabled(id: string, enabled: boolean): Promise<AutomationTask> {
  const res = await instance.patch('/automation/tasks/' + encodeURIComponent(id) + '/enabled', {
    enabled,
  })
  return res.data.data as AutomationTask
}

/** 立即运行任务，返回运行记录 id */
export async function runTaskNow(id: string): Promise<{ runId: string }> {
  const res = await instance.post('/automation/tasks/' + encodeURIComponent(id) + '/run')
  return res.data.data as { runId: string }
}

/** 运行记录分页（cursor 为上一页最后一条的 startedAt） */
export async function fetchRuns(params?: {
  taskId?: string
  limit?: number
  cursor?: number
}): Promise<AutomationRun[]> {
  const res = await instance.get('/automation/runs', {
    params: {
      task_id: params?.taskId,
      limit: params?.limit ?? 50,
      cursor: params?.cursor,
    },
  })
  return (res.data.data ?? []) as AutomationRun[]
}

/** 单条运行记录（运行结果详情） */
export async function fetchRun(id: string): Promise<AutomationRun> {
  const res = await instance.get('/automation/runs/' + encodeURIComponent(id))
  return res.data.data as AutomationRun
}

/** 运行统计（默认本周） */
export async function fetchRunStats(since?: number): Promise<AutomationRunStats> {
  const res = await instance.get('/automation/runs/stats', { params: { since } })
  return res.data.data as AutomationRunStats
}
