import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import SideMenu from '@/components/SideMenu.vue'
import { useBrandStore } from '@/stores/brand'
import { useUiStore } from '@/stores/ui'

vi.mock('@/services/settingsApi', () => ({
  fetchSystemSettings: vi.fn(),
  updateSystemSettings: vi.fn(),
  uploadSystemLogo: vi.fn(),
  resetSystemLogo: vi.fn(),
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

/** 侧栏用到 useRouter / useRoute，必须装一个真路由（内存历史即可） */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
}

async function mountSideMenu() {
  const router = makeRouter()
  await router.push('/')
  await router.isReady()
  const wrapper = mount(SideMenu, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('侧栏品牌区', () => {
  it('系统名称左侧有 LOGO，且名称取自品牌 store', async () => {
    useBrandStore().systemName = '未来工作台'
    const wrapper = await mountSideMenu()

    const brand = wrapper.find('.sidebar .brand')
    expect(brand.exists()).toBe(true)
    expect(brand.find('.brand-mark').exists()).toBe(true)
    expect(brand.find('.logo').text()).toBe('未来工作台')
  })

  it('未自定义 LOGO 时回退内置图形（svg）', async () => {
    const wrapper = await mountSideMenu()

    expect(wrapper.find('.sidebar .brand-mark').element.tagName.toLowerCase()).toBe('svg')
  })

  it('已自定义 LOGO 时渲染图片', async () => {
    const brand = useBrandStore()
    brand.logoUrl = '/api/settings/system/logo'
    const wrapper = await mountSideMenu()

    const mark = wrapper.find('.sidebar .brand-mark')
    expect(mark.element.tagName.toLowerCase()).toBe('img')
    expect(mark.attributes('src')).toBe('/api/settings/system/logo')
  })

  it('LOGO 在名称左边（DOM 顺序）', async () => {
    const wrapper = await mountSideMenu()

    const children = wrapper.find('.sidebar .brand').element.children
    expect(children[0].classList.contains('brand-mark')).toBe(true)
    expect(children[1].classList.contains('logo')).toBe(true)
  })

  it('侧栏收起时品牌区仍留在 DOM 里（靠 CSS 淡出塌陷，不是 v-if）', async () => {
    const ui = useUiStore()
    ui.sidebarCollapsed = true
    const wrapper = await mountSideMenu()

    // 用 CSS 而不是 v-if，才能和侧栏宽度动画同时进行
    expect(wrapper.find('.sidebar').classes()).toContain('collapsed')
    expect(wrapper.find('.sidebar .brand').exists()).toBe(true)
  })
})
