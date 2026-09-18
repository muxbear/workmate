import type { IpcMain } from 'electron'
import type { SettingsService } from '../settings/SettingsService'
import type { BrandLogoUpload } from '../settings/BrandLogoService'

export interface ConfigHandlerDeps {
  settingsService: SettingsService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/**
 * 归一化 LOGO 上传入参：渲染层经结构化克隆可能传 ArrayBuffer 或 Uint8Array，
 * 这里统一成字节视图交给业务层；结构非法返回 null。
 * 体积与图片类型校验属业务层职责（BrandLogoService），IPC 层不重复实现。
 */
function normalizeBrandLogoUpload(payload: unknown): BrandLogoUpload | null {
  if (!payload || typeof payload !== 'object') return null
  const { name, bytes } = payload as { name?: unknown; bytes?: unknown }
  const fileName = typeof name === 'string' ? name : undefined
  if (bytes instanceof ArrayBuffer) return { name: fileName, bytes: new Uint8Array(bytes) }
  if (ArrayBuffer.isView(bytes)) {
    const view = bytes as Uint8Array
    return {
      name: fileName,
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
  }
  return null
}

/**
 * 注册系统设置相关 IPC 通道
 * 机器级配置（与登录态无关），不调 session.requireUserId()；
 * 主进程为校验权威（白名单 + 类型/枚举/路径合法性），渲染层不可信
 */
export function registerConfigHandlers(ipc: IpcMain, deps: ConfigHandlerDeps): void {
  const { settingsService } = deps

  ipc.handle('config:get-all', async () => {
    try {
      return ok(settingsService.getAll())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:set', async (_event, key?: unknown, value?: unknown) => {
    if (typeof key !== 'string' || !key) return fail('参数错误')
    try {
      await settingsService.set(key, value)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:storage-stats', async () => {
    try {
      return ok(await settingsService.getStorageStats())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:select-workspace-dir', async () => {
    try {
      // 用户取消返回 null（success: true），对齐 workspace:select-dir
      return ok(await settingsService.selectWorkspaceDir())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:select-knowledge-dir', async () => {
    try {
      // 用户取消返回 null（success: true），对齐 config:select-workspace-dir
      return ok(await settingsService.selectKnowledgeDir())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:get-brand-logo', async () => {
    try {
      return ok(settingsService.getBrandLogo())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:upload-brand-logo', async (_event, payload?: unknown) => {
    try {
      const upload = normalizeBrandLogoUpload(payload)
      if (!upload) return fail('参数错误')
      return ok(await settingsService.uploadBrandLogo(upload))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:reset-brand-logo', async () => {
    try {
      return ok(await settingsService.resetBrandLogo())
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('config:open-data-dir', async () => {
    try {
      await settingsService.openDataDir()
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
