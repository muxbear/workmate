import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { ExpertSyncService } from '../experts/ExpertSyncService'
import type { ExpertSyncProgress } from '../../shared/contracts'
import { createCommandRegistrar } from './command'
import { errorMessage } from './ipc-result'

interface ExpertSyncHandlerDeps {
  expertSyncService: ExpertSyncService
  session: SessionService
}

/** 专家 id 校验（与技能 id 校验一致：非空字符串 + 长度上限） */
function isValidExpertId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

/** 注册 Web 专家同步 IPC 通道（含主进程 → 渲染层的同步进度事件）。 */
export function registerExpertSyncHandlers(ipc: IpcMain, deps: ExpertSyncHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { expertSyncService } = deps

  registerCommand<[], unknown>(ipc, 'expert-sync:status', {
    auth: 'user',
    execute: (ctx) => expertSyncService.getStatus(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'expert-sync:authorize', {
    auth: 'user',
    execute: (ctx) => expertSyncService.authorize(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'expert-sync:sync', {
    auth: 'user',
    execute: async (ctx) => {
      const sendProgress = (p: ExpertSyncProgress): void => {
        if (!ctx.event.sender.isDestroyed()) {
          ctx.event.sender.send('expert-sync:progress', p)
        }
      }
      try {
        return await expertSyncService.sync(ctx.userId as string, sendProgress)
      } catch (err) {
        // 失败兜底：补推 error 阶段进度（常规进度由服务内部回调驱动）
        sendProgress({ phase: 'error', percent: 0, message: errorMessage(err) })
        throw err
      }
    }
  })

  /** 读取 ~/.ke-work/experts/experts.json（专家页挂载与同步完成后加载） */
  registerCommand<[], unknown>(ipc, 'expert-sync:load-local', {
    auth: 'user',
    execute: () => expertSyncService.loadLocal()
  })

  /** 删除本地专家（仅本机副本；服务端仍存在时下次同步按版本重新拉回） */
  registerCommand<[string], unknown>(ipc, 'expert-sync:delete-expert', {
    auth: 'user',
    // 保持既有文案且在会话校验前返回（ESH-03 钉死：非法入参不触碰服务与会话）
    parse: ([expertId]) => {
      if (!isValidExpertId(expertId)) throw new Error('参数错误：专家 id 无效')
      return [expertId]
    },
    execute: (_ctx, expertId) => expertSyncService.deleteExpert(expertId)
  })

  registerCommand<[], null>(ipc, 'expert-sync:disconnect', {
    auth: 'user',
    execute: async (ctx) => {
      await expertSyncService.disconnect(ctx.userId as string)
      return null
    }
  })
}
