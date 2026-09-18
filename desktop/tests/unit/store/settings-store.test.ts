import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from '../../../src/renderer/src/store/settings'

/** 内存版 window.api（仅设置相关通道） */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createMockWindowApi() {
  const store = new Map<string, unknown>([
    ['ui.language', 'zh-CN'],
    ['ui.fontSize', 17],
    ['ui.systemName', 'Ke-Work']
  ])
  const api = {
    setZoomFactor: vi.fn(),
    getAllSettings: vi.fn(async () => ({
      success: true,
      data: {
        settings: Object.fromEntries(store),
        meta: { dataBaseDir: 'C:\\Users\\t\\.ke-work', defaultWorkspaceDir: 'C:\\Users\\t\\KeWork' }
      }
    })),
    setSetting: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
      return { success: true, data: null }
    }),
    listWorkspaces: vi.fn(async () => ({ success: true, data: [] })),
    getStorageStats: vi.fn(async () => ({
      success: true,
      data: { baseDir: '/tmp', usedBytes: 1024, diskTotal: 1024 * 1024, diskFree: 512 * 1024 }
    })),
    selectDefaultWorkspaceDir: vi.fn(async () => ({ success: true, data: null })),
    openDataDir: vi.fn(async () => ({ success: true, data: null })),
    // ── 系统标识（「系统设置 → 系统标识」）──
    getBrandLogo: vi.fn(async () => ({
      success: true,
      data: { fileName: '', dataUrl: '', customized: false }
    })),
    uploadBrandLogo: vi.fn(async () => ({
      success: true,
      data: { fileName: 'logo-1.png', dataUrl: 'data:image/png;base64,AA==', customized: true }
    })),
    resetBrandLogo: vi.fn(async () => ({
      success: true,
      data: { fileName: '', dataUrl: '', customized: false }
    }))
  }
  return { api, store }
}

describe('useSettingsStore（渲染层系统设置）', () => {
  let mock: ReturnType<typeof createMockWindowApi>

  beforeEach(() => {
    setActivePinia(createPinia())
    mock = createMockWindowApi()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn()
    }
    ;(globalThis as Record<string, unknown>).window = { api: mock.api }
    // 主题根节点标记与窗口标题都写 DOM，这里给出最小 document 替身
    ;(globalThis as Record<string, unknown>).document = {
      title: '',
      documentElement: { dataset: {} as Record<string, string> }
    }
    mock.api.setZoomFactor.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('load：回填字段 + meta + 应用字体缩放', async () => {
    const s = useSettingsStore()
    await s.load()
    expect(s.language).toBe('zh-CN')
    expect(s.fontSize).toBe(17)
    expect(s.meta?.defaultWorkspaceDir).toBe('C:\\Users\\t\\KeWork')
    expect(s.loaded).toBe(true)
    expect(mock.api.setZoomFactor).toHaveBeenCalledWith(1) // 17/17
  })

  it('load：主进程返回的设置覆盖默认值', async () => {
    mock.store.set('ui.language', 'en')
    mock.store.set('ui.fontSize', 20)
    const s = useSettingsStore()
    await s.load()
    expect(s.language).toBe('en')
    expect(s.fontSize).toBe(20)
    expect(mock.api.setZoomFactor).toHaveBeenCalledWith(20 / 17)
  })

  it('set：乐观更新本地 + 防抖 300ms 合并持久化', async () => {
    vi.useFakeTimers()
    const s = useSettingsStore()
    await s.load()
    await s.set('ui.language', 'en')
    expect(s.language).toBe('en') // 乐观更新（未等待 IPC）
    expect(mock.api.setSetting).not.toHaveBeenCalled() // 防抖未到期
    await vi.advanceTimersByTimeAsync(300)
    expect(mock.api.setSetting).toHaveBeenCalledWith('ui.language', 'en')
  })

  it('set：同一 key 连续写只落最后值', async () => {
    vi.useFakeTimers()
    const s = useSettingsStore()
    await s.load()
    await s.set('ui.language', 'en')
    await s.set('ui.language', 'zh-TW')
    await vi.advanceTimersByTimeAsync(300)
    expect(mock.api.setSetting).toHaveBeenCalledTimes(1)
    expect(mock.api.setSetting).toHaveBeenCalledWith('ui.language', 'zh-TW')
  })

  it('set 失败：回滚（重新 load 以主进程为准）', async () => {
    vi.useFakeTimers()
    mock.api.setSetting.mockResolvedValue({ success: false, error: '设置值非法' } as never)
    const s = useSettingsStore()
    await s.load()
    await s.set('ui.language', 'fr-FR')
    await vi.advanceTimersByTimeAsync(300)
    expect(s.language).toBe('zh-CN') // 回滚为已持久化值
  })

  it('系统名称：默认回退内置名，set 后即时更新窗口标题', async () => {
    const s = useSettingsStore()
    await s.load()
    expect(s.systemName).toBe('Ke-Work')
    await s.set('ui.systemName', 'My Work')
    expect(s.systemName).toBe('My Work')
    const doc = (globalThis as Record<string, unknown>).document as { title: string }
    expect(doc.title).toBe('My Work桌面')
  })

  it('系统标识：load 回填 LOGO 快照，上传/恢复默认同步状态', async () => {
    const s = useSettingsStore()
    await s.load()
    expect(s.hasCustomLogo).toBe(false)

    mock.api.uploadBrandLogo.mockResolvedValue({
      success: true,
      data: { fileName: 'logo-1.png', dataUrl: 'data:image/png;base64,AA==', customized: true }
    } as never)
    await s.uploadBrandLogo(new File([new Uint8Array([1])], 'logo.png'))
    expect(s.hasCustomLogo).toBe(true)
    expect(s.brandLogoFileName).toBe('logo-1.png')
    expect(mock.api.uploadBrandLogo).toHaveBeenCalledWith({
      name: 'logo.png',
      bytes: expect.any(ArrayBuffer)
    })

    await s.resetBrandLogo()
    expect(s.hasCustomLogo).toBe(false)
    expect(s.brandLogoDataUrl).toBe('')
  })

  it('系统标识：上传失败抛出主进程错误文案（调用方展示）', async () => {
    mock.api.uploadBrandLogo.mockResolvedValue({
      success: false,
      error: '仅支持 PNG / JPG / WEBP / SVG 格式的图片'
    } as never)
    const s = useSettingsStore()
    await s.load()
    await expect(
      s.uploadBrandLogo(new File([new Uint8Array([1])], 'logo.gif'))
    ).rejects.toThrow('仅支持 PNG / JPG / WEBP / SVG 格式的图片')
    expect(s.hasCustomLogo).toBe(false)
  })

  it('refreshStorageStats：回填存储统计', async () => {
    const s = useSettingsStore()
    await s.refreshStorageStats()
    expect(s.storageStats?.usedBytes).toBe(1024)
  })

  it('changeWorkspaceDir：选择成功时更新路径与 meta', async () => {
    mock.api.selectDefaultWorkspaceDir.mockResolvedValue({
      success: true,
      data: 'D:\\MyWork'
    } as never)
    const s = useSettingsStore()
    await s.load()
    await s.changeWorkspaceDir()
    expect(s.defaultWorkspaceDir).toBe('D:\\MyWork')
    expect(s.meta?.defaultWorkspaceDir).toBe('D:\\MyWork')
  })

  it('changeWorkspaceDir：取消（null）不更新', async () => {
    const s = useSettingsStore()
    await s.load()
    await s.changeWorkspaceDir()
    expect(s.defaultWorkspaceDir).toBe('')
  })

  it('load 失败：保留首帧默认值不抛错', async () => {
    mock.api.getAllSettings.mockResolvedValue({ success: false, error: 'boom' } as never)
    const s = useSettingsStore()
    await expect(s.load()).resolves.toBeUndefined()
    expect(s.fontSize).toBe(17)
    expect(s.loaded).toBe(false)
  })
})
