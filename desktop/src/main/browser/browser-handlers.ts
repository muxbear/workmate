import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BrowserViewManager } from './BrowserViewManager'
import type { WorkspaceService } from '../workspace/WorkspaceService'
import type { SessionService } from '../services/SessionService'

interface BrowserHandlerDeps {
  getBrowserManager: (event: IpcMainInvokeEvent) => BrowserViewManager
  workspaceService: WorkspaceService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function registerBrowserHandlers(ipc: IpcMain, deps: BrowserHandlerDeps): void {
  ipc.handle('browser:navigate', async (event, rawUrl?: unknown) => {
    try {
      deps.session.requireUserId()
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fail('参数错误')
      await deps.getBrowserManager(event).navigate(rawUrl.trim())
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle(
    'browser:open-workspace-file',
    async (event, workspaceId?: unknown, relPath?: unknown) => {
      try {
        const userId = deps.session.requireUserId()
        if (typeof workspaceId !== 'string' || !workspaceId) return fail('参数错误')
        if (typeof relPath !== 'string' || !relPath) return fail('参数错误')

        const ws = deps.workspaceService.resolveWorkspace(workspaceId, userId)
        if (!ws) return fail('工作空间不存在或目录已移除')
        const filePath = deps.workspaceService.resolveFilePath(workspaceId, userId, relPath)
        const preview = await deps
          .getBrowserManager(event)
          .openWorkspaceFile(workspaceId, relPath, ws.dir, filePath)
        return ok(preview)
      } catch (error) {
        return fail((error as Error).message)
      }
    }
  )

  ipc.handle('browser:back', async (event) => {
    try {
      deps.session.requireUserId()
      deps.getBrowserManager(event).back()
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle('browser:forward', async (event) => {
    try {
      deps.session.requireUserId()
      deps.getBrowserManager(event).forward()
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle('browser:reload', async (event) => {
    try {
      deps.session.requireUserId()
      deps.getBrowserManager(event).reload()
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle('browser:stop', async (event) => {
    try {
      deps.session.requireUserId()
      deps.getBrowserManager(event).stop()
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle('browser:open-external', async (event) => {
    try {
      deps.session.requireUserId()
      await deps.getBrowserManager(event).openExternalCurrent()
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })

  ipc.handle(
    'browser:set-bounds',
    async (event, bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }) => {
      try {
        if (!bounds) return fail('参数错误')
        if (
          !isFiniteNonNegativeNumber(bounds.x) ||
          !isFiniteNonNegativeNumber(bounds.y) ||
          !isFiniteNonNegativeNumber(bounds.width) ||
          !isFiniteNonNegativeNumber(bounds.height)
        ) {
          return fail('参数错误')
        }
        deps.getBrowserManager(event).setBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
        return ok(null)
      } catch (error) {
        return fail((error as Error).message)
      }
    }
  )

  ipc.handle('browser:set-visible', async (event, visible?: unknown) => {
    try {
      if (typeof visible !== 'boolean') return fail('参数错误')
      deps.getBrowserManager(event).setVisible(visible)
      return ok(null)
    } catch (error) {
      return fail((error as Error).message)
    }
  })
}
