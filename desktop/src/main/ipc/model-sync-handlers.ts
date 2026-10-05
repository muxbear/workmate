import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { ModelSyncService } from '../models/ModelSyncService'
import { createCommandRegistrar } from './command'

interface ModelSyncHandlerDeps {
  modelSyncService: ModelSyncService
  session: SessionService
}

/** 注册自定义模型同步 IPC 通道（全部要求登录态，userId 由主进程注入） */
export function registerModelSyncHandlers(ipc: IpcMain, deps: ModelSyncHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { modelSyncService } = deps

  registerCommand<[], unknown>(ipc, 'model-sync:status', {
    auth: 'user',
    execute: (ctx) => modelSyncService.getStatus(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'model-sync:authorize', {
    auth: 'user',
    execute: (ctx) => modelSyncService.authorize(ctx.userId as string)
  })

  registerCommand<[], unknown>(ipc, 'model-sync:sync', {
    auth: 'user',
    execute: (ctx) => modelSyncService.sync(ctx.userId as string)
  })

  registerCommand<[], null>(ipc, 'model-sync:disconnect', {
    auth: 'user',
    execute: async (ctx) => {
      await modelSyncService.disconnect(ctx.userId as string)
      return null
    }
  })
}
