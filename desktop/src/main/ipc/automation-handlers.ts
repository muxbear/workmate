import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { AutomationService } from '../automation/AutomationService'
import { createCommandRegistrar } from './command'

export interface AutomationHandlerDeps {
  automationService: AutomationService
  session: SessionService
}

/**
 * 注册自动化相关 IPC 通道
 *
 * **用户隔离**：鉴权统一声明为 user（注册器取 session.requireUserId()），
 * 渲染层只传任务 id 与表单字段，不传 userId；入参校验由服务层负责。
 */
export function registerAutomationHandlers(ipc: IpcMain, deps: AutomationHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { automationService } = deps

  registerCommand<[], unknown>(ipc, 'automation:list-tasks', {
    auth: 'user',
    execute: (ctx) => automationService.listTasks(ctx.userId as string)
  })

  registerCommand<[unknown], unknown>(ipc, 'automation:get-task', {
    auth: 'user',
    execute: (ctx, id) => automationService.getTask(ctx.userId as string, id)
  })

  registerCommand<[unknown], unknown>(ipc, 'automation:create-task', {
    auth: 'user',
    execute: (ctx, draft) => automationService.createTask(ctx.userId as string, draft)
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'automation:update-task', {
    auth: 'user',
    execute: (ctx, id, draft) => automationService.updateTask(ctx.userId as string, id, draft)
  })

  registerCommand<[unknown], unknown>(ipc, 'automation:delete-task', {
    auth: 'user',
    execute: (ctx, id) => automationService.deleteTask(ctx.userId as string, id)
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'automation:set-enabled', {
    auth: 'user',
    execute: (ctx, id, enabled) => automationService.setEnabled(ctx.userId as string, id, enabled)
  })

  registerCommand<[unknown], unknown>(ipc, 'automation:run-now', {
    auth: 'user',
    execute: (ctx, id) => automationService.runNow(ctx.userId as string, id)
  })

  registerCommand<[{ taskId?: unknown; limit?: unknown; cursor?: unknown }], unknown>(
    ipc,
    'automation:list-runs',
    {
      auth: 'user',
      execute: (ctx, opts) => automationService.listRuns(ctx.userId as string, opts)
    }
  )

  registerCommand<[unknown], unknown>(ipc, 'automation:get-run', {
    auth: 'user',
    execute: (ctx, id) => automationService.getRun(ctx.userId as string, id)
  })

  registerCommand<[unknown], unknown>(ipc, 'automation:run-stats', {
    auth: 'user',
    execute: (ctx, since) => automationService.runStats(ctx.userId as string, since)
  })
}
