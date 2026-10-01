import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import i18n from '@/locales'
import { DEFAULT_FONT_SIZE, clampFontSize, fontZoomValue, useUiStore } from '@/stores/ui'
import * as settingsApi from '@/services/settingsApi'

vi.mock('@/services/settingsApi', () => ({
  fetchSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  uploadSystemLogo: vi.fn(),
  resetSystemLogo: vi.fn(),
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

const fetchPreferences = vi.mocked(settingsApi.fetchPreferences)
const updatePreferences = vi.mocked(settingsApi.updatePreferences)

const DEFAULTS = {
  language: 'zh-CN' as const,
  fontSize: 17,
  clientNotifications: true,
  notificationSound: 'none' as const,
}

/**
 * jsdom 的 CSSStyleDeclaration **不支持 `zoom`**（非标准属性），
 * `setProperty('zoom', x)` 会被静默丢弃，`getPropertyValue('zoom')` 永远是空串。
 * 所以这里用 spy 断言真实调用，而不是去读回样式值——读回来的一律是空串，
 * 那种断言即使代码完全没生效也会通过（或者像最初那样永远失败）。
 */
function zoomSpies() {
  const style = document.documentElement.style
  return {
    set: vi.spyOn(style, 'setProperty'),
    remove: vi.spyOn(style, 'removeProperty'),
  }
}

/** 只取针对 `zoom` 的调用参数；setProperty 是 [name, value]，removeProperty 只有 [name] */
function zoomCalls(spy: ReturnType<typeof zoomSpies>['set']): unknown[][] {
  return spy.mock.calls.filter(([name]) => name === 'zoom')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 注意：tests/setup.ts 把同一个对象同时装成 localStorage 和 sessionStorage，
  // ui_font_size 会跨测试文件可见，不能依赖隔离。
  window.localStorage.clear()
  document.documentElement.style.removeProperty('zoom')
  i18n.global.locale.value = 'zh-CN'
})

describe('clampFontSize', () => {
  it('收敛到 12–24', () => {
    expect(clampFontSize(24)).toBe(24)
    expect(clampFontSize(12)).toBe(12)
    expect(clampFontSize(99)).toBe(24)
    expect(clampFontSize(0)).toBe(12)
  })

  it('非数字回落默认值', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE)
  })
})

describe('fontZoomValue（比例换算）', () => {
  it('以 17 为基准', () => {
    expect(fontZoomValue(24)).toBe(String(24 / 17))
    expect(fontZoomValue(12)).toBe(String(12 / 17))
  })

  it('默认字号返回 null，表示应移除内联样式而不是写 1', () => {
    expect(fontZoomValue(DEFAULT_FONT_SIZE)).toBeNull()
  })

  it('越界值先收敛再换算', () => {
    expect(fontZoomValue(99)).toBe(String(24 / 17))
    expect(fontZoomValue(0)).toBe(String(12 / 17))
    expect(fontZoomValue(Number.NaN)).toBeNull()
  })
})

describe('字号缩放', () => {
  it('以 17 为基准按比例设置根元素 zoom', () => {
    const spies = zoomSpies()
    const ui = useUiStore()

    ui.setFontSize(24)

    expect(ui.fontSize).toBe(24)
    expect(zoomCalls(spies.set)).toEqual([['zoom', String(24 / 17)]])
    spies.set.mockRestore()
    spies.remove.mockRestore()
  })

  it('回到默认 17 时移除内联 zoom，不留残留样式', () => {
    const spies = zoomSpies()
    const ui = useUiStore()
    ui.setFontSize(24)

    ui.setFontSize(DEFAULT_FONT_SIZE)

    expect(zoomCalls(spies.remove)).toEqual([['zoom']])
    // 关键：默认值不能再写一次 zoom:1，否则内联样式会一直挂在 <html> 上
    expect(zoomCalls(spies.set)).toEqual([['zoom', String(24 / 17)]])
    spies.set.mockRestore()
    spies.remove.mockRestore()
  })

  it('写入 localStorage，供 index.html 在首帧前预置', () => {
    const ui = useUiStore()
    ui.setFontSize(20)
    expect(window.localStorage.getItem('ui_font_size')).toBe('20')
  })

  it('initAppearance 在挂载前就应用已有字号', () => {
    window.localStorage.setItem('ui_font_size', '24')
    const ui = useUiStore()
    const spies = zoomSpies()

    ui.initAppearance()

    expect(zoomCalls(spies.set)).toEqual([['zoom', String(24 / 17)]])
    spies.set.mockRestore()
    spies.remove.mockRestore()
  })
})

describe('偏好加载', () => {
  it('服务端语言同时落到 i18n 与 ui store（单一事实来源）', async () => {
    fetchPreferences.mockResolvedValue({ ...DEFAULTS, language: 'en', fontSize: 20 })
    const ui = useUiStore()

    await ui.loadPreferences('user-a')

    // 两个切换器都读 locale，也只有一个写入 i18n 的入口，因此不可能不同步
    expect(ui.locale).toBe('en')
    expect(i18n.global.locale.value).toBe('en')
    expect(ui.fontSize).toBe(20)
  })

  it('同一用户重复调用只拉一次', async () => {
    fetchPreferences.mockResolvedValue(DEFAULTS)
    const ui = useUiStore()

    await ui.loadPreferences('user-a')
    await ui.loadPreferences('user-a')

    expect(fetchPreferences).toHaveBeenCalledTimes(1)
  })

  it('换用户必须重新拉取，不能继承上一个人的偏好', async () => {
    fetchPreferences.mockResolvedValue({ ...DEFAULTS, fontSize: 24 })
    const ui = useUiStore()
    await ui.loadPreferences('user-a')

    fetchPreferences.mockResolvedValue({ ...DEFAULTS, fontSize: 12 })
    await ui.loadPreferences('user-b')

    expect(fetchPreferences).toHaveBeenCalledTimes(2)
    expect(ui.fontSize).toBe(12)
  })

  it('未登录（userId 为空）不请求', async () => {
    const ui = useUiStore()

    await ui.loadPreferences(null)

    expect(fetchPreferences).not.toHaveBeenCalled()
  })

  it('接口失败时保持本地值，不抛异常', async () => {
    fetchPreferences.mockRejectedValue(new Error('网络异常'))
    const ui = useUiStore()

    await expect(ui.loadPreferences('user-a')).resolves.toBeUndefined()

    expect(ui.locale).toBe('zh-CN')
    expect(ui.fontSize).toBe(DEFAULT_FONT_SIZE)
  })
})

describe('登出清理', () => {
  it('复位字号并撤销 zoom，避免泄漏给下一位用户', async () => {
    fetchPreferences.mockResolvedValue({ ...DEFAULTS, fontSize: 24, language: 'en' })
    const ui = useUiStore()
    await ui.loadPreferences('user-a')

    const spies = zoomSpies()
    ui.clearPreferences()

    expect(ui.fontSize).toBe(DEFAULT_FONT_SIZE)
    // 撤销 zoom 是这条用例的重点：下一个人不该在偏好请求回来前先看到上一个人的大字号
    expect(zoomCalls(spies.remove)).toEqual([['zoom']])
    expect(ui.clientNotifications).toBe(true)
    expect(ui.notificationSound).toBe('none')
    spies.set.mockRestore()
    spies.remove.mockRestore()
  })

  it('清理后同一用户再登录会重新拉取', async () => {
    fetchPreferences.mockResolvedValue(DEFAULTS)
    const ui = useUiStore()
    await ui.loadPreferences('user-a')

    ui.clearPreferences()
    await ui.loadPreferences('user-a')

    expect(fetchPreferences).toHaveBeenCalledTimes(2)
  })
})

describe('偏好写入', () => {
  it('改语言失败时回滚，界面与库里不会不一致', async () => {
    updatePreferences.mockRejectedValue(new Error('保存失败'))
    const ui = useUiStore()

    await expect(ui.saveLanguage('en')).rejects.toThrow()

    expect(ui.locale).toBe('zh-CN')
    expect(i18n.global.locale.value).toBe('zh-CN')
  })

  it('改语言成功时本地立即生效并写入服务端', async () => {
    updatePreferences.mockResolvedValue({ ...DEFAULTS, language: 'en' })
    const ui = useUiStore()

    await ui.saveLanguage('en')

    expect(ui.locale).toBe('en')
    expect(updatePreferences).toHaveBeenCalledWith({ language: 'en' })
  })

  it('提交失败时回滚到服务端确认过的字号，而不是拖动前的值', async () => {
    fetchPreferences.mockResolvedValue({ ...DEFAULTS, fontSize: 20 })
    const ui = useUiStore()
    await ui.loadPreferences('user-a')

    // 拖动过程中本地值已经变成 24 了——"改之前的值"这时候是 24 而不是 20，
    // 拿它当回滚目标等于没回滚
    ui.setFontSize(24)
    updatePreferences.mockRejectedValue(new Error('保存失败'))

    await expect(ui.persistFontSize(24)).rejects.toThrow()

    expect(ui.fontSize).toBe(20)
  })

  it('字号写入前先收敛到合法区间', async () => {
    updatePreferences.mockResolvedValue(DEFAULTS)
    const ui = useUiStore()

    await ui.saveFontSize(99)

    expect(updatePreferences).toHaveBeenCalledWith({ fontSize: 24 })
    expect(ui.fontSize).toBe(24)
  })

  it('通知开关只写服务端，不落 localStorage', async () => {
    updatePreferences.mockResolvedValue(DEFAULTS)
    const ui = useUiStore()

    ui.setClientNotifications(false)
    ui.setNotificationSound('soft')
    await vi.waitFor(() => expect(updatePreferences).toHaveBeenCalledTimes(2))

    expect(ui.clientNotifications).toBe(false)
    expect(ui.notificationSound).toBe('soft')
    // 这两个首屏不渲染任何东西，落本地只会制造跨用户泄漏
    expect(window.localStorage.getItem('ui_client_notifications')).toBeNull()
  })
})
