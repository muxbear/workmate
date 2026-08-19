import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { SkillSyncService } from '../skills/SkillSyncService'

interface SkillSyncHandlerDeps {
  skillSyncService: SkillSyncService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 注册 Web 技能同步 IPC 通道。 */
export function registerSkillSyncHandlers(ipc: IpcMain, deps: SkillSyncHandlerDeps): void {
  const { skillSyncService, session } = deps

  ipc.handle('skill-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(skillSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await skillSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:sync', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await skillSyncService.sync(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:cached', async () => {
    try {
      session.requireUserId()
      return ok(skillSyncService.getCachedSkills())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('skill-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await skillSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
