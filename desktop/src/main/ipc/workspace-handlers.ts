import type { IpcMain } from 'electron'
import type { WorkspaceService } from '../workspace/WorkspaceService'
import type { SessionService } from '../services/SessionService'
import type { IConversationMetaStore } from '../agent/IConversationMetaStore'
import { createCommandRegistrar } from './command'

export interface WorkspaceHandlerDeps {
  workspaceService: WorkspaceService
  session: SessionService
  /** 级联删除会话：移除工作空间时先删其下会话数据 */
  conversationStore: IConversationMetaStore
  /** 选择 zip 保存位置（系统「另存为」）；缺省时导出到工作空间根目录 */
  chooseZipPath?: (defaultName: string) => Promise<string | null>
  /** 导出完成后在系统文件管理器中定位文件 */
  revealFile?: (absPath: string) => Promise<void>
}

/**
 * 注册工作空间相关 IPC 通道
 * 工作空间按登录用户隔离（主进程 session 注入 userId）；
 * 渲染层只传 id/name，路径一律由主进程解析，防路径注入
 */
export function registerWorkspaceHandlers(ipc: IpcMain, deps: WorkspaceHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { workspaceService, conversationStore } = deps

  registerCommand<[], unknown>(ipc, 'workspace:list', {
    auth: 'user',
    execute: (ctx) => workspaceService.list(ctx.userId as string)
  })

  registerCommand<[string], unknown>(ipc, 'workspace:create', {
    auth: 'user',
    parse: ([name]) => (typeof name === 'string' && name.trim() ? [name] : null),
    execute: (ctx, name) => workspaceService.createWorkspace(name, ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'workspace:select-dir', {
    auth: 'user',
    // 用户取消时返回 null（success: true）
    execute: (ctx) => workspaceService.selectExternalDir(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'workspace:default', {
    auth: 'user',
    execute: () => workspaceService.ensureDefaultWorkspace()
  })

  registerCommand<[string], null>(ipc, 'workspace:open', {
    auth: 'user',
    parse: ([id]) => (typeof id === 'string' && id ? [id] : null),
    execute: async (ctx, id) => {
      await workspaceService.openWorkspace(id, ctx.userId as string)
      return null
    }
  })

  registerCommand<[string], null>(ipc, 'workspace:delete', {
    auth: 'user',
    parse: ([id]) => (typeof id === 'string' && id ? [id] : null),
    execute: async (ctx, id) => {
      const userId = ctx.userId as string
      // 先守卫可删除性（默认空间不可删），再做不可逆的级联删除
      workspaceService.assertDeletable(id, userId)
      await conversationStore.deleteConversationsByWorkspace(userId, id)
      workspaceService.deleteWorkspace(id, userId)
      return null
    }
  })

  registerCommand<[string, string], unknown>(ipc, 'workspace:list-files', {
    auth: 'user',
    parse: ([id, relPath]) => {
      if (typeof id !== 'string' || !id) return null
      if (relPath !== undefined && typeof relPath !== 'string') return null
      return [id, relPath ?? '']
    },
    execute: (ctx, id, relPath) => workspaceService.listFiles(id, ctx.userId as string, relPath)
  })

  registerCommand<[string, string, number | undefined], unknown>(ipc, 'workspace:read-file', {
    auth: 'user',
    parse: ([id, relPath, cursor]) => {
      if (typeof id !== 'string' || !id || typeof relPath !== 'string') return null
      if (cursor !== undefined && (typeof cursor !== 'number' || !Number.isFinite(cursor))) {
        return null
      }
      return [id, relPath, cursor as number | undefined]
    },
    execute: (ctx, id, relPath, cursor) =>
      workspaceService.readFile(id, ctx.userId as string, relPath, cursor)
  })

  registerCommand<[string, string], unknown>(ipc, 'workspace:read-file-bytes', {
    auth: 'user',
    parse: ([id, relPath]) =>
      typeof id === 'string' && id && typeof relPath === 'string' ? [id, relPath] : null,
    execute: (ctx, id, relPath) => workspaceService.readFileBytes(id, ctx.userId as string, relPath)
  })

  registerCommand<[string, string], unknown>(ipc, 'workspace:read-image-bytes', {
    auth: 'user',
    parse: ([id, relPath]) =>
      typeof id === 'string' && id && typeof relPath === 'string' ? [id, relPath] : null,
    execute: (ctx, id, relPath) => workspaceService.readImageBytes(id, ctx.userId as string, relPath)
  })

  registerCommand<[string, string], unknown>(ipc, 'workspace:read-media-bytes', {
    auth: 'user',
    parse: ([id, relPath]) =>
      typeof id === 'string' && id && typeof relPath === 'string' ? [id, relPath] : null,
    execute: (ctx, id, relPath) => workspaceService.readMediaBytes(id, ctx.userId as string, relPath)
  })

  registerCommand<[string, string[], string | undefined], unknown>(ipc, 'workspace:export-zip', {
    auth: 'user',
    parse: ([id, relPaths, zipName]) => {
      if (typeof id !== 'string' || !id) return null
      if (!Array.isArray(relPaths) || relPaths.some((item) => typeof item !== 'string')) return null
      return [id, relPaths as string[], typeof zipName === 'string' ? zipName : undefined]
    },
    execute: async (ctx, id, paths, name) => {
      const userId = ctx.userId as string

      let destAbsPath: string | undefined
      if (deps.chooseZipPath) {
        const chosen = await deps.chooseZipPath(workspaceService.suggestZipName(paths, name))
        if (!chosen) {
          // 用户取消另存为：不落盘，返回取消标记由渲染层静默处理
          return { canceled: true, relPath: '', absPath: '', entries: 0, size: 0 }
        }
        destAbsPath = chosen
      }

      const result = await workspaceService.exportZip(id, userId, paths, name, destAbsPath)
      if (deps.revealFile) {
        try {
          await deps.revealFile(result.absPath)
        } catch (err) {
          console.warn('[workspace] reveal exported zip failed:', err)
        }
      }
      return { ...result, canceled: false }
    }
  })

  registerCommand<[string, string, Uint8Array | ArrayBuffer], null>(ipc, 'workspace:write-file', {
    auth: 'user',
    parse: ([id, relPath, bytes]) => {
      if (typeof id !== 'string' || !id || typeof relPath !== 'string') return null
      if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) return null
      return [id, relPath, bytes]
    },
    execute: async (ctx, id, relPath, bytes) => {
      await workspaceService.writeFile(id, ctx.userId as string, relPath, bytes)
      return null
    }
  })
}
