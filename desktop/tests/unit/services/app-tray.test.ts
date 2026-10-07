import { describe, expect, it, vi } from 'vitest'
import {
  buildTrayMenuTemplate,
  createAppTray,
  type TrayLike,
  type TrayMenuItem
} from '../../../src/main/services/appTray'

/**
 * 系统托盘控制器单测（「最小化到托盘」的图标生命周期与菜单接线）。
 *
 * 真实 Tray/Menu 由 index.ts 注入，这里用假托盘钉住：
 * 懒创建幂等 / 提示文案刷新 / 左右键唤回窗口 / 菜单「退出应用」接线 / 销毁可重建。
 */

class FakeTray implements TrayLike {
  tooltips: string[] = []
  menus: TrayMenuItem[][] = []
  listeners = new Map<string, Array<() => void>>()
  destroyed = false

  setToolTip(tooltip: string): void {
    this.tooltips.push(tooltip)
  }
  setContextMenu(menu: unknown): void {
    this.menus.push(menu as TrayMenuItem[])
  }
  on(event: 'click' | 'double-click', listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }
  destroy(): void {
    this.destroyed = true
  }
  emit(event: 'click' | 'double-click'): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

interface TestHarness {
  trays: FakeTray[]
  handlers: { showWindow: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn> }
  controller: ReturnType<typeof createAppTray>
  setTooltip: (tooltip: string) => void
}

function setup(tooltip = 'Ke-Work'): TestHarness {
  const trays: FakeTray[] = []
  const handlers = { showWindow: vi.fn(), quit: vi.fn() }
  let currentTooltip = tooltip
  const controller = createAppTray({
    createTray: () => {
      const tray = new FakeTray()
      trays.push(tray)
      return tray
    },
    buildMenu: (template) => template,
    getTooltip: () => currentTooltip,
    handlers
  })
  return {
    trays,
    handlers,
    controller,
    setTooltip: (t: string): void => {
      currentTooltip = t
    }
  }
}

describe('buildTrayMenuTemplate（托盘右键菜单）', () => {
  it('菜单项与顺序：显示主窗口 / 分隔线 / 退出应用，点击接上对应 handler', () => {
    const showWindow = vi.fn()
    const quit = vi.fn()
    const template = buildTrayMenuTemplate({ showWindow, quit })
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      '显示主窗口',
      'separator',
      '退出应用'
    ])
    template[0].click?.()
    template[2].click?.()
    expect(showWindow).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe('createAppTray（托盘生命周期）', () => {
  it('懒创建：ensure 前不存在，ensure 后创建一次并设置提示与菜单', () => {
    const { trays, controller } = setup('Ke-Work')
    expect(controller.isCreated()).toBe(false)
    controller.ensure()
    expect(controller.isCreated()).toBe(true)
    expect(trays).toHaveLength(1)
    expect(trays[0].tooltips).toEqual(['Ke-Work'])
    expect(trays[0].menus).toHaveLength(1)
    expect(trays[0].destroyed).toBe(false)
  })

  it('幂等：重复 ensure 不重复创建，仅刷新悬浮提示（系统名称可改）', () => {
    const { trays, controller, setTooltip } = setup('Ke-Work')
    controller.ensure()
    setTooltip('新系统名')
    controller.ensure()
    controller.ensure()
    expect(trays).toHaveLength(1)
    expect(trays[0].tooltips).toEqual(['Ke-Work', '新系统名', '新系统名'])
  })

  it('左键单击 / 双击图标都唤回主窗口', () => {
    const { trays, handlers, controller } = setup()
    controller.ensure()
    trays[0].emit('click')
    trays[0].emit('double-click')
    expect(handlers.showWindow).toHaveBeenCalledTimes(2)
  })

  it('菜单「退出应用」接的是注入的 quit（实现方须先 latch 退出标志）', () => {
    const { trays, handlers, controller } = setup()
    controller.ensure()
    const menu = trays[0].menus[0]
    menu[2].click?.()
    expect(handlers.quit).toHaveBeenCalledTimes(1)
    expect(handlers.showWindow).not.toHaveBeenCalled()
  })

  it('destroy 后 isCreated 为 false，再 ensure 可重建新托盘', () => {
    const { trays, controller } = setup()
    controller.ensure()
    controller.destroy()
    expect(controller.isCreated()).toBe(false)
    expect(trays[0].destroyed).toBe(true)

    controller.ensure()
    expect(controller.isCreated()).toBe(true)
    expect(trays).toHaveLength(2)
    expect(trays[1].destroyed).toBe(false)
  })

  it('未创建时 destroy 是空操作（不抛错）', () => {
    const { controller } = setup()
    expect(() => controller.destroy()).not.toThrow()
    expect(controller.isCreated()).toBe(false)
  })
})
