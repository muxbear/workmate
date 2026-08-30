import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { ModelSyncService } from '../models/ModelSyncService'

interface ModelSyncHandlerDeps {
  modelSyncService: ModelSyncService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

export function registerModelSyncHandlers(ipc: IpcMain, deps: ModelSyncHandlerDeps): void {
  const { modelSyncService, session } = deps

  ipc.handle('model-sync:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(modelSyncService.getStatus(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('model-sync:authorize', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await modelSyncService.authorize(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('model-sync:sync', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await modelSyncService.sync(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('model-sync:disconnect', async () => {
    try {
      const userId = session.requireUserId()
      await modelSyncService.disconnect(userId)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
