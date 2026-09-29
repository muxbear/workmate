import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import SystemSettingsPage from '../../../src/renderer/src/components/settings/pages/SystemSettingsPage.vue'
import { useSettingsStore } from '../../../src/renderer/src/store/settings'

/**
 * 「设置 → 系统设置 → 系统标识」卡片渲染验证（SSR，无需 jsdom）
 *
 * 能钉住：卡片结构与文案（保存按钮、名称回填、恢复默认可见性、渲染期零写入）。
 * 不能钉住：「输入 / 选文件不写主进程」的交互语义 —— SSR 不跑 onMounted、不派发事件。
 * 该语义由 brand-identity-draft.test.ts（保存计划穷举）与真机 e2e 用例保证。
 */

type SettingsStore = ReturnType<typeof useSettingsStore>

/** 渲染期应保持零调用的写入类通道桩 */
function stubWindowApi(): Record<string, ReturnType<typeof vi.fn>> {
  const ok = (data: unknown): { success: true; data: unknown } => ({ success: true, data })
  const snapshot = (): { success: true; data: unknown } =>
    ok({ fileName: '', dataUrl: '', customized: false })
  const api = {
    setZoomFactor: vi.fn(),
    setSetting: vi.fn(async () => ok(null)),
    getBrandLogo: vi.fn(async () => snapshot()),
    uploadBrandLogo: vi.fn(async () => snapshot()),
    resetBrandLogo: vi.fn(async () => snapshot()),
    openDataDir: vi.fn(async () => ok(null)),
    getStorageStats: vi.fn(async () => ok(null)),
    selectDefaultWorkspaceDir: vi.fn(async () => ok(null)),
    selectKnowledgeDir: vi.fn(async () => ok(null))
  }
  ;(globalThis as Record<string, unknown>).window = { api }
  return api
}

/** 以给定 store 状态渲染页面（store 字段直接赋值，不经过主进程） */
async function render(setup: (store: SettingsStore) => void = (): void => {}): Promise<string> {
  const pinia = createPinia()
  setActivePinia(pinia)
  setup(useSettingsStore())
  const app = createSSRApp(SystemSettingsPage)
  app.use(pinia)
  return renderToString(app)
}

let api: ReturnType<typeof stubWindowApi>

beforeEach(() => {
  api = stubWindowApi()
})

describe('SystemSettingsPage「系统标识」（草稿 + 保存）', () => {
  it('渲染「保存」主按钮，名称输入框回填已保存的系统名', async () => {
    const html = await render((store) => {
      store.systemName = '我的工作台'
    })

    expect(html).toMatch(/<button[^>]*s-btn--primary[^>]*>\s*保存\s*<\/button>/)
    expect(html).toContain('aria-label="系统名称"')
    expect(html).toContain('value="我的工作台"')
  })

  it('文案说明改为「点击保存后生效」', async () => {
    const html = await render()

    expect(html).toContain('点击「保存」后生效')
    expect(html).not.toContain('修改后立即生效，并同步到登录页')
  })

  it('「恢复默认」仅在已自定义 LOGO 时出现', async () => {
    expect(await render()).not.toContain('恢复默认')

    const custom = await render((store) => {
      store.brandLogoFileName = 'logo-1.png'
      store.brandLogoDataUrl = 'data:image/png;base64,AA=='
    })
    expect(custom).toContain('恢复默认')
    expect(custom).toContain('data:image/png;base64,AA==')
  })

  it('渲染期不写主进程（写入类 IPC 零调用）', async () => {
    await render()

    expect(api.setSetting).not.toHaveBeenCalled()
    expect(api.uploadBrandLogo).not.toHaveBeenCalled()
    expect(api.resetBrandLogo).not.toHaveBeenCalled()
  })
})
