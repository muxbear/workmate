import type { IpcMain } from 'electron'
import { stat } from 'fs/promises'
import { classifyPath, limitForKind, type FileKind } from '../../shared/file-kinds'
import { createCommandRegistrar } from './command'

/** file:inspect 依赖：登录态守卫（受保护 IPC 路由，主进程会话校验）。 */
export interface FileInspectDeps {
  requireUserId: () => string
}

/** 注册 file:inspect：选中文件时即时校验（存在性 + 类型分类 + 大小），供渲染层拒绝非法附件。 */
export function registerFileHandlers(ipcMain: IpcMain, deps: FileInspectDeps): void {
  const registerCommand = createCommandRegistrar(deps.requireUserId)

  registerCommand<
    [unknown],
    { exists: boolean; size: number; kind: FileKind | 'missing'; maxBytes?: number }
  >(ipcMain, 'file:inspect', {
    auth: 'user',
    // 参数校验保持在会话校验之后（历史顺序）
    execute: async (_ctx, path) => {
      if (typeof path !== 'string' || !path) throw new Error('参数错误')
      const info = await stat(path).catch(() => null)
      // 文件不存在不是错误：返回 exists:false 供渲染层提示（与既有语义一致）
      if (!info || !info.isFile()) {
        return { exists: false, size: 0, kind: 'missing' as const }
      }
      const kind = classifyPath(path)
      return { exists: true, size: info.size, kind, maxBytes: limitForKind(kind) }
    }
  })
}
