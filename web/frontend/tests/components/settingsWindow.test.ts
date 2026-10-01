import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { ElMessage } from 'element-plus'
import { nextTick } from 'vue'
import SettingsWindow from '@/components/settings/SettingsWindow.vue'
import { useBrandStore } from '@/stores/brand'
import { useUiStore } from '@/stores/ui'
import * as settingsApi from '@/services/settingsApi'

vi.mock('@/services/settingsApi', () => ({
  fetchSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  uploadSystemLogo: vi.fn(),
  resetSystemLogo: vi.fn(),
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

const updateSystemSettings = vi.mocked(settingsApi.updateSystemSettings)
const uploadSystemLogo = vi.mocked(settingsApi.uploadSystemLogo)
const updatePreferences = vi.mocked(settingsApi.updatePreferences)

/**
 * 复用 beforeEach 建好的那个 pinia，而不是每次新建：
 * 有的用例需要**先改 store 状态再挂载**（如预置一个已自定义的 LOGO），
 * 每次新建 pinia 的话改的是上一个实例，组件根本读不到。
 */
function mountWindow() {
  return mount(SettingsWindow, {
    global: { plugins: [getActivePinia() ?? createPinia()] },
  })
}

/** 打开设置窗口并等待渲染 */
async function mountOpen() {
  const ui = useUiStore()
  ui.openSettings()
  const wrapper = mountWindow()
  await flushPromises()
  return { wrapper, ui }
}

/** 往隐藏的 file input 里塞一个文件并触发 change */
async function pickLogo(wrapper: ReturnType<typeof mountWindow>, file: File) {
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

function oversizedPng(): File {
  const file = new File(['x'], 'big.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 })
  return file
}

async function typeName(wrapper: ReturnType<typeof mountWindow>, name: string) {
  const input = wrapper.find('input[aria-label="系统名称"]')
  await input.setValue(name)
  await flushPromises()
}

/**
 * 造一个"正开着的" Element Plus 下拉。
 *
 * jsdom 里 `getBoundingClientRect()` 返回全 0，而组件靠高度判断浮层是否可见，
 * 所以必须显式桩一个非零高度，否则这条用例测不出让位逻辑。
 */
function fakeOpenDropdown(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'el-select-dropdown'
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      height: 120,
      width: 120,
      top: 0,
      left: 0,
      right: 120,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  window.localStorage.clear()
})

afterEach(() => {
  document.querySelectorAll('.el-select-dropdown').forEach((el) => el.remove())
})

describe('设置窗口的开关', () => {
  it('默认关闭时什么都不渲染', () => {
    const wrapper = mountWindow()

    expect(wrapper.find('.settings-mask').exists()).toBe(false)
    expect(wrapper.find('.settings-card').exists()).toBe(false)
  })

  it('打开后渲染为带遮罩的弹出窗口', async () => {
    const { wrapper } = await mountOpen()

    expect(wrapper.find('.settings-mask').exists()).toBe(true)
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-label')).toBe('设置')
  })

  it('点右上角关闭按钮关掉', async () => {
    const { wrapper, ui } = await mountOpen()

    await wrapper.find('.settings-close').trigger('click')
    await nextTick()

    expect(ui.settingsOpen).toBe(false)
  })

  it('点遮罩关掉', async () => {
    const { wrapper, ui } = await mountOpen()

    await wrapper.find('.settings-mask').trigger('click')
    await nextTick()

    expect(ui.settingsOpen).toBe(false)
  })

  it('点卡片内部不会关掉', async () => {
    const { wrapper, ui } = await mountOpen()

    await wrapper.find('.settings-card').trigger('click')
    await nextTick()

    expect(ui.settingsOpen).toBe(true)
  })

  it('按 Esc 关掉', async () => {
    const { ui } = await mountOpen()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(ui.settingsOpen).toBe(false)
  })

  it('有下拉开着时 Esc 先关下拉，不关窗口', async () => {
    const { ui } = await mountOpen()
    // jsdom 的 getBoundingClientRect 全是 0，得自己造一个有高度的
    const dropdown = fakeOpenDropdown()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(ui.settingsOpen).toBe(true)
    dropdown.remove()
  })

  it('窗口没开时 Esc 不误伤其它浮层', async () => {
    const ui = useUiStore()
    mountWindow() // 未打开

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(ui.settingsOpen).toBe(false)
  })
})

describe('设置窗口的内容', () => {
  it('左栏只有「系统设置」一项且为选中态', async () => {
    const { wrapper } = await mountOpen()

    const items = wrapper.findAll('.settings-nav-item')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('系统设置')
    expect(items[0].classes()).toContain('settings-nav-item--active')
  })

  it('标题与左侧品牌名跟随系统名称', async () => {
    useBrandStore().systemName = '未来工作台'
    const { wrapper } = await mountOpen()

    expect(wrapper.find('.settings-title').text()).toBe('系统设置')
    expect(wrapper.find('.settings-brand-text').text()).toBe('未来工作台设置')
  })

  it('渲染四个区块标题', async () => {
    const { wrapper } = await mountOpen()
    const text = wrapper.text()

    expect(text).toContain('系统标识')
    expect(text).toContain('显示语言')
    expect(text).toContain('字体大小')
    expect(text).toContain('客户端通知')
    expect(text).toContain('提示音设置')
  })
})

describe('系统标识的草稿语义', () => {
  it('名称超长时本地拦下，且不发任何请求', async () => {
    const infoSpy = vi.spyOn(ElMessage, 'info')
    const { wrapper } = await mountOpen()

    await typeName(wrapper, 'x'.repeat(25))
    await wrapper.find('.s-brand-footer button').trigger('click')
    await flushPromises()

    expect(wrapper.find('.s-error').text()).toBe('系统名称不能超过 24 个字符')
    expect(updateSystemSettings).not.toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })

  it('什么都没改时提示「无需保存」，且不发请求', async () => {
    const infoSpy = vi.spyOn(ElMessage, 'info').mockImplementation(() => ({}) as never)
    const { wrapper } = await mountOpen()

    await wrapper.find('.s-brand-footer button').trigger('click')
    await flushPromises()

    expect(infoSpy).toHaveBeenCalledWith('系统标识已是最新，无需保存')
    expect(updateSystemSettings).not.toHaveBeenCalled()
    expect(uploadSystemLogo).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })

  it('改名后保存会提交并同步到品牌 store', async () => {
    const successSpy = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({}) as never)
    updateSystemSettings.mockResolvedValue({ systemName: '我的工作台', logoUrl: null })
    const { wrapper } = await mountOpen()

    await typeName(wrapper, '我的工作台')
    await wrapper.find('.s-brand-footer button').trigger('click')
    await flushPromises()

    expect(updateSystemSettings).toHaveBeenCalledWith({ systemName: '我的工作台' })
    expect(useBrandStore().systemName).toBe('我的工作台')
    expect(document.title).toBe('我的工作台')
    expect(successSpy).toHaveBeenCalledWith('系统标识已保存')
    successSpy.mockRestore()
  })

  it('超过 1MB 的图片被本地拦下，且不上传', async () => {
    const { wrapper } = await mountOpen()

    await pickLogo(wrapper, oversizedPng())

    expect(wrapper.find('.s-error').text()).toBe('LOGO 大小不能超过 1MB')
    expect(uploadSystemLogo).not.toHaveBeenCalled()
  })

  it('合法文件只在点保存时才上传，选中本身不发请求', async () => {
    uploadSystemLogo.mockResolvedValue({
      systemName: 'Ke-Work',
      logoUrl: '/api/settings/system/logo',
    })
    const { wrapper } = await mountOpen()

    await pickLogo(wrapper, new File(['x'], 'logo.png', { type: 'image/png' }))

    // 草稿语义：选中只是改本地状态
    expect(uploadSystemLogo).not.toHaveBeenCalled()

    await wrapper.find('.s-brand-footer button').trigger('click')
    await flushPromises()

    expect(uploadSystemLogo).toHaveBeenCalledTimes(1)
    expect(uploadSystemLogo.mock.calls[0][0]).toBeInstanceOf(File)
  })

  it('没有自定义 LOGO 时「恢复默认」不显示', async () => {
    const { wrapper } = await mountOpen()

    const labels = wrapper.findAll('.s-brand-actions button').map((b) => b.text())
    expect(labels).toEqual(['选择图片'])
  })

  it('已有自定义 LOGO 时「恢复默认」显示', async () => {
    // 必须先改 store 再挂载：草稿的可见性由挂载时的品牌状态决定
    useBrandStore().logoUrl = '/api/settings/system/logo'
    const { wrapper } = await mountOpen()

    const labels = wrapper.findAll('.s-brand-actions button').map((b) => b.text())
    expect(labels).toEqual(['选择图片', '恢复默认'])
  })
})

describe('偏好控件', () => {
  it('字号滑块：拖动只跟手不落库，松手才提交新值', async () => {
    updatePreferences.mockResolvedValue({
      language: 'zh-CN',
      fontSize: 24,
      clientNotifications: true,
      notificationSound: 'none',
    })
    const { wrapper } = await mountOpen()
    const slider = wrapper.findComponent({ name: 'ElSlider' })

    slider.vm.$emit('input', 24)
    await flushPromises()
    expect(useUiStore().fontSize).toBe(24)

    // 受控滑块必须把新值写回 model，否则组件会在 mouseup 前回退成 prop 值，
    // change 报出来的是改动之前的值——看着在动、存下去的却是旧值（已踩过）
    expect(updatePreferences).not.toHaveBeenCalled()

    slider.vm.$emit('change', 24)
    await flushPromises()
    expect(updatePreferences).toHaveBeenCalledWith({ fontSize: 24 })
  })
})
