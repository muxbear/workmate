import type { IpcMain } from 'electron'
import type { RemoteImageService } from '../images/RemoteImageService'

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
  ipcMain.handle('images:resolve', async (_event, url?: unknown) => {
    try {
      deps.requireUserId()
    } catch (err) {
      return { success: false, error: (err as Error).message || '未登录' }
    }
    if (typeof url !== 'string' || !url) {
      return { success: false, error: '参数错误' }
    }
    try {
      const localUrl = await deps.remoteImageService.resolveRemoteImage(url)
      return { success: true, data: { url: localUrl } }
    } catch (err) {
      return { success: false, error: (err as Error).message || '图片解析失败' }
    }
  })
}
