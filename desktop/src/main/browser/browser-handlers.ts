import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BrowserViewManager } from './BrowserViewManager'
import type { WorkspaceService } from '../workspace/WorkspaceService'
import type { SessionService } from '../services/SessionService'
import { createCommandRegistrar } from '../ipc/command'

interface BrowserHandlerDeps {
  getBrowserManager: (event: IpcMainInvokeEvent) => BrowserViewManager
  workspaceService: WorkspaceService
  session: SessionService
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * 注册内嵌浏览器 IPC 通道。
 * 导航/历史/文件打开类通道鉴权为 user（参数校验保持在会话校验之后，历史顺序）；
 * set-bounds / set-visible 历史实现未做会话校验（纯窗口几何/可见性操作），保持原状。
 */
export function registerBrowserHandlers(ipc: IpcMain, deps: BrowserHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())

  registerCommand<[unknown], null>(ipc, 'browser:navigate', {
    auth: 'user',
    execute: async (ctx, rawUrl) => {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error('参数错误')
      await deps.getBrowserManager(ctx.event).navigate(rawUrl.trim())
      return null
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'browser:open-workspace-file', {
    auth: 'user',
    execute: async (ctx, workspaceId, relPath) => {
      const userId = ctx.userId as string
      if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('参数错误')
      if (typeof relPath !== 'string' || !relPath) throw new Error('参数错误')

      const ws = deps.workspaceService.resolveWorkspace(workspaceId, userId)
      if (!ws) throw new Error('工作空间不存在或目录已移除')
      const filePath = deps.workspaceService.resolveFilePath(workspaceId, userId, relPath)
      return deps
        .getBrowserManager(ctx.event)
        .openWorkspaceFile(workspaceId, relPath, ws.dir, filePath)
    }
  })

  registerCommand<[], null>(ipc, 'browser:back', {
    auth: 'user',
    execute: (ctx) => {
      deps.getBrowserManager(ctx.event).back()
      return null
    }
  })

  registerCommand<[], null>(ipc, 'browser:forward', {
    auth: 'user',
    execute: (ctx) => {
      deps.getBrowserManager(ctx.event).forward()
      return null
    }
  })

  registerCommand<[], null>(ipc, 'browser:reload', {
    auth: 'user',
    execute: (ctx) => {
      deps.getBrowserManager(ctx.event).reload()
      return null
    }
  })

  registerCommand<[], null>(ipc, 'browser:stop', {
    auth: 'user',
    execute: (ctx) => {
      deps.getBrowserManager(ctx.event).stop()
      return null
    }
  })

  registerCommand<[], null>(ipc, 'browser:open-external', {
    auth: 'user',
    execute: async (ctx) => {
      await deps.getBrowserManager(ctx.event).openExternalCurrent()
      return null
    }
  })

  registerCommand<[{ x: number; y: number; width: number; height: number }], null>(
    ipc,
    'browser:set-bounds',
    {
      // 历史实现未做会话校验（纯窗口几何操作），保持原状
      auth: 'none',
      parse: ([bounds]) => {
        if (!bounds || typeof bounds !== 'object') return null
        const b = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
        if (
          !isFiniteNonNegativeNumber(b.x) ||
          !isFiniteNonNegativeNumber(b.y) ||
          !isFiniteNonNegativeNumber(b.width) ||
          !isFiniteNonNegativeNumber(b.height)
        ) {
          return null
        }
        return [{ x: b.x, y: b.y, width: b.width, height: b.height }]
      },
      execute: (ctx, bounds) => {
        deps.getBrowserManager(ctx.event).setBounds(bounds)
        return null
      }
    }
  )

  registerCommand<[boolean], null>(ipc, 'browser:set-visible', {
    // 历史实现未做会话校验（纯可见性操作），保持原状
    auth: 'none',
    parse: ([visible]) => (typeof visible === 'boolean' ? [visible] : null),
    execute: (ctx, visible) => {
      deps.getBrowserManager(ctx.event).setVisible(visible)
      return null
    }
  })
}
