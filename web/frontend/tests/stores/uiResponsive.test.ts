import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '@/stores/ui'

/**
 * 侧栏按视口自动收起（迭代 6 T6.6）。
 *
 * 此前折叠**只能手动点**：`SideMenu` 是硬 240px 且带 `min-width`，永远不会自己收缩，
 * 窄屏下被挤扁的是内容区。方案 `:1322` 的验收是"窄屏（1280/768）布局不破"，1280 是
 * 点名的基准之一。
 *
 * 测试靠 `tests/setup.ts` 里的 `matchMedia` 桩（jsdom 不实现它），桩会按新宽度**真的
 * 重算** `matches` 再通知监听者。
 */

declare global {
  interface Window {
    __setViewportWidth?: (width: number) => void
  }
}

function setWidth(width: number) {
  window.__setViewportWidth?.(width)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('侧栏的视口响应', () => {
  it('窄屏（< 1280）自动收起', () => {
    setWidth(1100)
    const ui = useUiStore()

    const dispose = ui.initResponsiveSidebar()

    expect(ui.sidebarCollapsed).toBe(true)
    dispose()
  })

  it('宽屏保持展开', () => {
    setWidth(1600)
    const ui = useUiStore()

    const dispose = ui.initResponsiveSidebar()

    expect(ui.sidebarCollapsed).toBe(false)
    dispose()
  })

  it('从宽变窄时收起', () => {
    setWidth(1600)
    const ui = useUiStore()
    const dispose = ui.initResponsiveSidebar()
    expect(ui.sidebarCollapsed).toBe(false)

    setWidth(900)

    expect(ui.sidebarCollapsed).toBe(true)
    dispose()
  })

  it('变宽时还原用户原本的选择，而不是一律展开', () => {
    // 用户在宽屏上手动收起了侧栏；缩窄再变宽后，应该还是他选的"收起"——
    // 否则自动逻辑会悄悄改掉用户的偏好
    setWidth(1600)
    const ui = useUiStore()
    ui.toggleSidebar()  // 用户手动收起
    expect(ui.sidebarCollapsed).toBe(true)
    const dispose = ui.initResponsiveSidebar()

    setWidth(900)
    setWidth(1600)

    expect(ui.sidebarCollapsed).toBe(true)
    dispose()
  })

  it('卸载后不再响应视口变化', () => {
    setWidth(1600)
    const ui = useUiStore()
    const dispose = ui.initResponsiveSidebar()
    dispose()

    setWidth(900)

    expect(ui.sidebarCollapsed).toBe(false)
  })
})
