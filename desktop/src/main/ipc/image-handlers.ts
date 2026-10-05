import type { IpcMain } from 'electron'
import type { RemoteImageService } from '../images/RemoteImageService'
import { createCommandRegistrar } from './command'

/** images:resolve 依赖：登录态守卫 + 远程图片缓存服务 */
export interface RemoteImageResolveDeps {
  remoteImageService: RemoteImageService
  requireUserId: () => string
}

/**
 * 注册 images:resolve：把远程图片 URL 解析为本地 ke-img:// 缓存地址。
 * 渲染层在渲染 Markdown 图片前调用，保证 <img src> 指向 CSP 放行的本地协议。
 */
export function registerRemoteImageHandlers(ipcMain: IpcMain, deps: RemoteImageResolveDeps): void {
  const registerCommand = createCommandRegistrar(deps.requireUserId)

  registerCommand<[unknown], { url: string }>(ipcMain, 'images:resolve', {
    auth: 'user',
    // 参数校验保持在会话校验之后（历史顺序）
    execute: async (_ctx, url) => {
      if (typeof url !== 'string' || !url) throw new Error('参数错误')
      return { url: await deps.remoteImageService.resolveRemoteImage(url) }
    }
  })
}
