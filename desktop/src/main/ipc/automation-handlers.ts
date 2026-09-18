import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { AutomationService } from '../automation/AutomationService'

export interface AutomationHandlerDeps {
  automationService: AutomationService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/**
 * 注册自动化相关 IPC 通道
 *
 * **用户隔离**：所有通道第一行取 session.requireUserId()，
 * 渲染层只传任务 id 与表单字段，不传 userId。
 */
export function registerAutomationHandlers(ipc: IpcMain, deps: AutomationHandlerDeps): void {
  const { automationService, session } = deps

  ipc.handle('automation:list-tasks', async () => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.listTasks(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:get-task', async (_event, id?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.getTask(userId, id))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:create-task', async (_event, draft?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.createTask(userId, draft))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:update-task', async (_event, id?: unknown, draft?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.updateTask(userId, id, draft))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:delete-task', async (_event, id?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.deleteTask(userId, id))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:set-enabled', async (_event, id?: unknown, enabled?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.setEnabled(userId, id, enabled))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation:run-now', async (_event, id?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(await automationService.runNow(userId, id))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle(
    'automation:list-runs',
    async (_event, opts?: { taskId?: unknown; limit?: unknown; cursor?: unknown }) => {
      try {
        const userId = session.requireUserId()
        return ok(automationService.listRuns(userId, opts))
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle('automation:run-stats', async (_event, since?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(automationService.runStats(userId, since))
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
