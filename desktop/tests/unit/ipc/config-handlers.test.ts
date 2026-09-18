import { describe, expect, it, vi } from 'vitest'
import { registerConfigHandlers } from '../../../src/main/ipc/config-handlers'
import type { SettingsService } from '../../../src/main/settings/SettingsService'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    handlers,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return handlers.get(channel)!({} as never, ...args) as T
    }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createSettingsServiceMock(
  overrides: Partial<Record<keyof SettingsService, unknown>> = {}
) {
  return {
    getAll: vi.fn(() => ({
      settings: {},
      meta: { dataBaseDir: '/tmp', defaultWorkspaceDir: 'C:\\KeWork' }
    })),
    set: vi.fn(),
    getStorageStats: vi.fn(async () => ({
      baseDir: '/tmp',
      usedBytes: 1024,
      diskTotal: 1024 * 1024,
      diskFree: 512 * 1024
    })),
    selectWorkspaceDir: vi.fn(async () => null),
    openDataDir: vi.fn(async () => undefined),
    getBrandLogo: vi.fn(() => ({ fileName: '', dataUrl: '', customized: false })),
    uploadBrandLogo: vi.fn(async () => ({
      fileName: 'logo-1.png',
      dataUrl: 'data:image/png;base64,AA==',
      customized: true
    })),
    resetBrandLogo: vi.fn(async () => ({ fileName: '', dataUrl: '', customized: false })),
    ...overrides
  }
}

describe('config IPC handlers', () => {
  it('注册 8 个通道', () => {
    const ipc = createFakeIpcMain()
    registerConfigHandlers(ipc as never, {
      settingsService: createSettingsServiceMock() as never
    })
    expect(ipc.handle).toHaveBeenCalledWith('config:get-all', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:set', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:storage-stats', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:select-workspace-dir', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:open-data-dir', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:get-brand-logo', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:upload-brand-logo', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('config:reset-brand-logo', expect.any(Function))
  })

  it('config:get-all 返回设置快照 + meta', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; data?: unknown }>('config:get-all')
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('meta')
  })

  it('config:set 合法参数透传并返回 ok', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean }>('config:set', 'ui.language', 'en')
    expect(result.success).toBe(true)
    expect(settingsService.set).toHaveBeenCalledWith('ui.language', 'en')
  })

  it('config:set 非法参数拒绝（key 非字符串）', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; error?: string }>('config:set', 123)
    expect(result.success).toBe(false)
    expect(settingsService.set).not.toHaveBeenCalled()
  })

  it('config:set 服务抛错转为 { success: false }', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock({
      set: vi.fn(() => {
        throw new Error('设置值非法')
      })
    })
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'config:set',
      'ui.language',
      'fr-FR'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('设置值非法')
  })

  it('config:storage-stats 返回统计', async () => {
    const ipc = createFakeIpcMain()
    registerConfigHandlers(ipc as never, {
      settingsService: createSettingsServiceMock() as never
    })
    const result = await ipc.invoke<{ success: boolean; data?: { usedBytes: number } }>(
      'config:storage-stats'
    )
    expect(result.success).toBe(true)
    expect(result.data?.usedBytes).toBe(1024)
  })

  it('config:select-workspace-dir 用户取消返回 null（success: true）', async () => {
    const ipc = createFakeIpcMain()
    registerConfigHandlers(ipc as never, {
      settingsService: createSettingsServiceMock() as never
    })
    const result = await ipc.invoke<{ success: boolean; data?: unknown }>(
      'config:select-workspace-dir'
    )
    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
  })

  it('config:get-brand-logo 返回 LOGO 快照', async () => {
    const ipc = createFakeIpcMain()
    registerConfigHandlers(ipc as never, {
      settingsService: createSettingsServiceMock() as never
    })
    const result = await ipc.invoke<{ success: boolean; data?: { customized: boolean } }>(
      'config:get-brand-logo'
    )
    expect(result.success).toBe(true)
    expect(result.data?.customized).toBe(false)
  })

  it('config:upload-brand-logo 透传字节并返回新快照', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const result = await ipc.invoke<{ success: boolean; data?: { fileName: string } }>(
      'config:upload-brand-logo',
      { name: 'logo.png', bytes }
    )
    expect(result.success).toBe(true)
    expect(result.data?.fileName).toBe('logo-1.png')
    expect(settingsService.uploadBrandLogo).toHaveBeenCalledWith({ name: 'logo.png', bytes })
  })

  it('config:upload-brand-logo 非法入参拒绝（bytes 非字节）', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'config:upload-brand-logo',
      { name: 'logo.png', bytes: 'not-bytes' }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('参数错误')
    expect(settingsService.uploadBrandLogo).not.toHaveBeenCalled()
  })

  it('config:upload-brand-logo 业务校验失败转 { success: false }', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock({
      uploadBrandLogo: vi.fn(() => {
        throw new Error('仅支持 PNG / JPG / WEBP / SVG 格式的图片')
      })
    })
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'config:upload-brand-logo',
      { name: 'evil.png', bytes: new Uint8Array([1, 2, 3]) }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('仅支持 PNG')
  })

  it('config:reset-brand-logo 恢复默认', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean; data?: { customized: boolean } }>(
      'config:reset-brand-logo'
    )
    expect(result.success).toBe(true)
    expect(result.data?.customized).toBe(false)
    expect(settingsService.resetBrandLogo).toHaveBeenCalled()
  })

  it('config:open-data-dir 返回 ok', async () => {
    const ipc = createFakeIpcMain()
    const settingsService = createSettingsServiceMock()
    registerConfigHandlers(ipc as never, { settingsService: settingsService as never })
    const result = await ipc.invoke<{ success: boolean }>('config:open-data-dir')
    expect(result.success).toBe(true)
    expect(settingsService.openDataDir).toHaveBeenCalled()
  })
})
