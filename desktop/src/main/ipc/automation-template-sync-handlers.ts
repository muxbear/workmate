import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { AutomationTemplateSyncService } from '../automation/AutomationTemplateSyncService'
import type { AutomationTemplateSyncProgress } from '../../shared/contracts'
import { createCommandRegistrar } from './command'
import { errorMessage } from './ipc-result'

interface AutomationTemplateSyncHandlerDeps {
  automationTemplateSyncService: AutomationTemplateSyncService
  session: SessionService
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
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { automationTemplateSyncService } = deps

  registerCommand<[], unknown>(ipc, 'automation-template-sync:status', {
    auth: 'user',
    execute: (ctx) => automationTemplateSyncService.getStatus(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'automation-template-sync:authorize', {
    auth: 'user',
    execute: (ctx) => automationTemplateSyncService.authorize(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'automation-template-sync:sync', {
    auth: 'user',
    execute: async (ctx) => {
      const sendProgress = (p: AutomationTemplateSyncProgress): void => {
        if (!ctx.event.sender.isDestroyed()) {
          ctx.event.sender.send('automation-template-sync:progress', p)
        }
      }
      try {
        return await automationTemplateSyncService.sync(ctx.userId as string, sendProgress)
      } catch (err) {
        // 失败兜底：补推 error 阶段进度（常规进度由服务内部回调驱动）
        sendProgress({ phase: 'error', percent: 0, message: errorMessage(err) })
        throw err
      }
    }
  })

  /** 读取 ~/.ke-work/automation-templates/templates.json（模板页挂载与同步完成后加载） */
  registerCommand<[], unknown>(ipc, 'automation-template-sync:load-local', {
    auth: 'user',
    execute: () => automationTemplateSyncService.loadLocal()
  })

  /** 删除本地模板（仅本机副本；服务端仍存在时下次同步按版本重新拉回） */
  registerCommand<[string], unknown>(ipc, 'automation-template-sync:delete-template', {
    auth: 'user',
    // 保持既有文案且在会话校验前返回（ATSH-03 钉死：非法入参不触碰服务与会话）
    parse: ([templateId]) => {
      if (!isValidTemplateId(templateId)) throw new Error('参数错误：模板 id 无效')
      return [templateId]
    },
    execute: (_ctx, templateId) => automationTemplateSyncService.deleteTemplate(templateId)
  })

  registerCommand<[], null>(ipc, 'automation-template-sync:disconnect', {
    auth: 'user',
    execute: async (ctx) => {
      await automationTemplateSyncService.disconnect(ctx.userId as string)
      return null
    }
  })
}
