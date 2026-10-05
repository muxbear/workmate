import type { IpcMain } from 'electron'
import type { SettingsService } from '../settings/SettingsService'
import type { BrandLogoUpload } from '../settings/BrandLogoService'
import { createCommandRegistrar } from './command'

export interface ConfigHandlerDeps {
  settingsService: SettingsService
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
  const registerCommand = createCommandRegistrar(null)
  const { settingsService } = deps

  registerCommand<[], unknown>(ipc, 'config:get-all', {
    auth: 'machine',
    execute: () => settingsService.getAll()
  })

  registerCommand<[string, unknown], null>(ipc, 'config:set', {
    auth: 'machine',
    parse: ([key, value]) => (typeof key === 'string' && key ? [key, value] : null),
    execute: async (_ctx, key, value) => {
      await settingsService.set(key, value)
      return null
    }
  })

  registerCommand<[], unknown>(ipc, 'config:storage-stats', {
    auth: 'machine',
    execute: () => settingsService.getStorageStats()
  })

  registerCommand<[], unknown>(ipc, 'config:select-workspace-dir', {
    auth: 'machine',
    // 用户取消返回 null（success: true），对齐 workspace:select-dir
    execute: () => settingsService.selectWorkspaceDir()
  })

  registerCommand<[], unknown>(ipc, 'config:select-knowledge-dir', {
    auth: 'machine',
    // 用户取消返回 null（success: true），对齐 config:select-workspace-dir
    execute: () => settingsService.selectKnowledgeDir()
  })

  registerCommand<[], unknown>(ipc, 'config:get-brand-logo', {
    auth: 'machine',
    execute: () => settingsService.getBrandLogo()
  })

  registerCommand<[BrandLogoUpload], unknown>(ipc, 'config:upload-brand-logo', {
    auth: 'machine',
    parse: ([payload]) => {
      const upload = normalizeBrandLogoUpload(payload)
      return upload ? [upload] : null
    },
    execute: (_ctx, upload) => settingsService.uploadBrandLogo(upload)
  })

  registerCommand<[], unknown>(ipc, 'config:reset-brand-logo', {
    auth: 'machine',
    execute: () => settingsService.resetBrandLogo()
  })

  registerCommand<[], null>(ipc, 'config:open-data-dir', {
    auth: 'machine',
    execute: async () => {
      await settingsService.openDataDir()
      return null
    }
  })
}
