import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { AutomationTemplateSyncService } from '../automation/AutomationTemplateSyncService'
import type { AutomationTemplateSyncProgress } from '../../preload/index.d'

interface AutomationTemplateSyncHandlerDeps {
  automationTemplateSyncService: AutomationTemplateSyncService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 模板 id 校验（与技能/专家 id 校验一致：非空字符串 + 长度上限） */
function isValidTemplateId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

/** 注册定时模板同步 IPC 通道（含主进程 → 渲染层的同步进度事件）。 */
export function registerAutomationTemplateSyncHandlers(
  ipc: IpcMain,
  deps: AutomationTemplateSyncHandlerDeps
): void {
  const { automationTemplateSyncService, session } = deps

  ipc.handle('automation-template-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(automationTemplateSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation-template-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await automationTemplateSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('automation-template-sync:sync', async (event: IpcMainInvokeEvent) => {
    const sendProgress = (p: AutomationTemplateSyncProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('automation-template-sync:progress', p)
      }
    }
    try {
      const userId = session.requireUserId()
      return ok(await automationTemplateSyncService.sync(userId, sendProgress))
    } catch (err) {
      const message = (err as Error).message
      sendProgress({ phase: 'error', percent: 0, message })
      return fail(message)
    }
  })

  /** 读取 ~/.ke-work/automation-templates/templates.json（模板页挂载与同步完成后加载） */
  ipc.handle('automation-template-sync:load-local', async () => {
    try {
      session.requireUserId()
      return ok(await automationTemplateSyncService.loadLocal())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 删除本地模板（仅本机副本；服务端仍存在时下次同步按版本重新拉回） */
  ipc.handle(
    'automation-template-sync:delete-template',
    async (_event: IpcMainInvokeEvent, templateId?: unknown) => {
      if (!isValidTemplateId(templateId)) return fail('参数错误：模板 id 无效')
      try {
        session.requireUserId()
        return ok(await automationTemplateSyncService.deleteTemplate(templateId))
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle('automation-template-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await automationTemplateSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
