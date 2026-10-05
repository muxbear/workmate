import type { IpcMain } from 'electron'
import type { BinaryManager, RuntimeId, RuntimeProgress } from '../runtime/BinaryManager'
import { createCommandRegistrar } from './command'

export interface RuntimeHandlerDeps {
  binaryManager: BinaryManager
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
  const registerCommand = createCommandRegistrar(null)
  const { binaryManager } = deps

  registerCommand<[], unknown>(ipc, 'runtime:list', {
    auth: 'machine',
    execute: () => binaryManager.listRuntimes()
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'runtime:install', {
    auth: 'machine',
    execute: async (ctx, id, version) => {
      // 保持既有文案（非「参数错误」）
      if (!isRuntimeId(id)) throw new Error('参数错误：未知的运行时标识')
      // 订阅 BinaryManager 进度事件，推送给发起安装的渲染进程
      const onProgress = (p: RuntimeProgress): void => {
        ctx.event.sender.send('runtime:progress', p)
      }
      binaryManager.on('progress', onProgress)
      try {
        await binaryManager.installRuntime(id, typeof version === 'string' ? version : undefined)
        return binaryManager.listRuntimes()
      } finally {
        binaryManager.off('progress', onProgress)
      }
    }
  })

  registerCommand<[unknown], unknown>(ipc, 'runtime:uninstall', {
    auth: 'machine',
    execute: async (_ctx, id) => {
      if (!isRuntimeId(id)) throw new Error('参数错误：未知的运行时标识')
      await binaryManager.uninstallRuntime(id)
      return binaryManager.listRuntimes()
    }
  })

  registerCommand<[unknown], unknown>(ipc, 'runtime:detect', {
    auth: 'machine',
    execute: async (_ctx, id) => {
      if (!isRuntimeId(id)) throw new Error('参数错误：未知的运行时标识')
      return binaryManager.detectRuntime(id)
    }
  })
}
