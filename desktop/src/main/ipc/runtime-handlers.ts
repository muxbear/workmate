import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BinaryManager, RuntimeId, RuntimeProgress } from '../runtime/BinaryManager'

export interface RuntimeHandlerDeps {
  binaryManager: BinaryManager
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 校验 RuntimeId */
function isRuntimeId(v: unknown): v is RuntimeId {
  return v === 'python' || v === 'node' || v === 'git'
}

/**
 * 注册内置运行时管理 IPC（机器级，不调 session.requireUserId）
 *
 * - runtime:list        → 列出所有运行时状态
 * - runtime:install     → 安装运行时（安装期间通过 runtime:progress 事件推送进度）
 * - runtime:uninstall   → 卸载运行时
 * - runtime:detect      → 探测已安装运行时版本
 * - runtime:progress    → 主进程 → 渲染层的进度推送事件
 */
export function registerRuntimeHandlers(ipc: IpcMain, deps: RuntimeHandlerDeps): void {
  const { binaryManager } = deps

  ipc.handle('runtime:list', async () => {
    try {
      return ok(binaryManager.listRuntimes())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('runtime:install', async (event: IpcMainInvokeEvent, id?: unknown, version?: unknown) => {
    if (!isRuntimeId(id)) return fail('参数错误：未知的运行时标识')

    // 订阅 BinaryManager 进度事件，推送给发起安装的渲染进程
    const onProgress = (p: RuntimeProgress): void => {
      event.sender.send('runtime:progress', p)
    }
    binaryManager.on('progress', onProgress)

    try {
      await binaryManager.installRuntime(id, typeof version === 'string' ? version : undefined)
      return ok(binaryManager.listRuntimes())
    } catch (err) {
      return fail((err as Error).message)
    } finally {
      binaryManager.off('progress', onProgress)
    }
  })

  ipc.handle('runtime:uninstall', async (_event, id?: unknown) => {
    if (!isRuntimeId(id)) return fail('参数错误：未知的运行时标识')
    try {
      await binaryManager.uninstallRuntime(id)
      return ok(binaryManager.listRuntimes())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('runtime:detect', async (_event, id?: unknown) => {
    if (!isRuntimeId(id)) return fail('参数错误：未知的运行时标识')
    try {
      const version = await binaryManager.detectRuntime(id)
      return ok(version)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}