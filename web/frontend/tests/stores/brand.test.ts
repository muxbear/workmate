import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_SYSTEM_NAME, useBrandStore } from '@/stores/brand'
import * as settingsApi from '@/services/settingsApi'

vi.mock('@/services/settingsApi', () => ({
  fetchSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  uploadSystemLogo: vi.fn(),
  resetSystemLogo: vi.fn(),
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

const fetchSystemSettings = vi.mocked(settingsApi.fetchSystemSettings)
const updateSystemSettings = vi.mocked(settingsApi.updateSystemSettings)
const uploadSystemLogo = vi.mocked(settingsApi.uploadSystemLogo)
const resetSystemLogo = vi.mocked(settingsApi.resetSystemLogo)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  window.localStorage.clear()
  document.title = DEFAULT_SYSTEM_NAME
})

describe('品牌状态加载', () => {
  it('拉到后端值后写入名称、LOGO 与浏览器标题', async () => {
    fetchSystemSettings.mockResolvedValue({
      systemName: '我的工作台',
      logoUrl: '/api/settings/system/logo',
    })
    const store = useBrandStore()

    await store.load()

    expect(store.systemName).toBe('我的工作台')
    expect(store.logoUrl).toBe('/api/settings/system/logo')
    expect(store.hasCustomLogo).toBe(true)
    expect(document.title).toBe('我的工作台')
  })

  it('接口失败时保持默认值与内置 LOGO，且不抛异常', async () => {
    fetchSystemSettings.mockRejectedValue(new Error('网络异常'))
    const store = useBrandStore()

    // 这是降级契约：后端不可达不能让登录页炸掉，也不能在首屏弹错误
    await expect(store.load()).resolves.toBeUndefined()

    expect(store.systemName).toBe(DEFAULT_SYSTEM_NAME)
    expect(store.logoUrl).toBeNull()
    expect(document.title).toBe(DEFAULT_SYSTEM_NAME)
    // 失败也要置位，页面不必一直等
    expect(store.loaded).toBe(true)
  })

  it('后端返回空白名称时回退默认值，标题不会变空', async () => {
    fetchSystemSettings.mockResolvedValue({ systemName: '   ', logoUrl: null })
    const store = useBrandStore()

    await store.load()

    expect(store.systemName).toBe(DEFAULT_SYSTEM_NAME)
    expect(document.title).toBe(DEFAULT_SYSTEM_NAME)
  })

  it('store 一创建就把标题写成默认名，不等网络', () => {
    document.title = '别的标题'
    useBrandStore()
    expect(document.title).toBe(DEFAULT_SYSTEM_NAME)
  })
})

describe('品牌写入', () => {
  it('改名后同步名称与标题', async () => {
    updateSystemSettings.mockResolvedValue({ systemName: '新名字', logoUrl: null })
    const store = useBrandStore()

    await store.saveSystemName('新名字')

    expect(updateSystemSettings).toHaveBeenCalledWith({ systemName: '新名字' })
    expect(store.systemName).toBe('新名字')
    expect(document.title).toBe('新名字')
  })

  it('换 LOGO 后地址加版本参数破缓存', async () => {
    fetchSystemSettings.mockResolvedValue({ systemName: 'X', logoUrl: '/api/settings/system/logo' })
    const store = useBrandStore()
    await store.load()
    const beforeRevision = store.logoRevision

    uploadSystemLogo.mockResolvedValue({ systemName: 'X', logoUrl: '/api/settings/system/logo' })
    await store.uploadLogo(new File(['x'], 'a.png'))

    // 地址没变但内容变了：不加版本参数的话浏览器会一直用旧图
    expect(store.logoRevision).toBe(beforeRevision + 1)
    expect(store.logoDisplaySrc).toContain('v=')
    expect(store.logoDisplaySrc).not.toBe(store.logoUrl)
  })

  it('恢复默认后 LOGO 地址为空，组件据此回退内置图形', async () => {
    fetchSystemSettings.mockResolvedValue({ systemName: 'X', logoUrl: '/api/settings/system/logo' })
    const store = useBrandStore()
    await store.load()

    resetSystemLogo.mockResolvedValue({ systemName: 'X', logoUrl: null })
    await store.resetLogo()

    expect(store.logoUrl).toBeNull()
    expect(store.logoDisplaySrc).toBeNull()
    expect(store.hasCustomLogo).toBe(false)
  })

  it('未自定义 LOGO 时不加版本参数', async () => {
    fetchSystemSettings.mockResolvedValue({ systemName: 'X', logoUrl: null })
    const store = useBrandStore()
    await store.load()

    expect(store.logoDisplaySrc).toBeNull()
  })
})
