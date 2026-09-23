import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { ExpertSyncService } from '../experts/ExpertSyncService'
import type { ExpertSyncProgress } from '../../preload/index.d'

interface ExpertSyncHandlerDeps {
  expertSyncService: ExpertSyncService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 专家 id 校验（与技能 id 校验一致：非空字符串 + 长度上限） */
function isValidExpertId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

/** 注册 Web 专家同步 IPC 通道（含主进程 → 渲染层的同步进度事件）。 */
export function registerExpertSyncHandlers(ipc: IpcMain, deps: ExpertSyncHandlerDeps): void {
  const { expertSyncService, session } = deps

  ipc.handle('expert-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(expertSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await expertSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('expert-sync:sync', async (event: IpcMainInvokeEvent) => {
    const sendProgress = (p: ExpertSyncProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('expert-sync:progress', p)
      }
    }
    try {
      const userId = session.requireUserId()
      return ok(await expertSyncService.sync(userId, sendProgress))
    } catch (err) {
      const message = (err as Error).message
      sendProgress({ phase: 'error', percent: 0, message })
      return fail(message)
    }
  })

  /** 读取 ~/.ke-work/experts/experts.json（专家页挂载与同步完成后加载） */
  ipc.handle('expert-sync:load-local', async () => {
    try {
      session.requireUserId()
      return ok(await expertSyncService.loadLocal())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 删除本地专家（仅本机副本；服务端仍存在时下次同步按版本重新拉回） */
  ipc.handle(
    'expert-sync:delete-expert',
    async (_event: IpcMainInvokeEvent, expertId?: unknown) => {
      if (!isValidExpertId(expertId)) return fail('参数错误：专家 id 无效')
      try {
        session.requireUserId()
        return ok(await expertSyncService.deleteExpert(expertId))
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle('expert-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await expertSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
