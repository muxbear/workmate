/**
 * 系统托盘控制器（「最小化到托盘」：任务栏右下角图标 + 右键菜单）
 *
 * 交互约定（Windows 交付口径）：
 * - 选择「最小化到托盘」时窗口隐藏（不占任务栏），通知区出现应用图标；
 * - 左键单击 / 双击图标 → 唤回主窗口；右键 → 菜单「显示主窗口 / 退出应用」；
 * - 托盘菜单「退出应用」= 彻底退出（调用方负责先 latch 退出标志再 app.quit()）。
 *
 * 纯逻辑模块：不引 electron 运行时（Tray/Menu 经依赖注入），便于单测。
 */

/** 托盘最小能力（electron Tray 结构兼容；单测注入假托盘） */
export interface TrayLike {
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click' | 'double-click', listener: () => void): unknown
  destroy(): void
}

export interface TrayMenuHandlers {
  /** 显示主窗口（左键单击 / 菜单「显示主窗口」） */
  showWindow: () => void
  /** 退出应用（菜单「退出应用」；实现方须先 markQuitting 再 app.quit()） */
  quit: () => void
}

/** 菜单项（electron Menu.buildFromTemplate 结构兼容） */
export interface TrayMenuItem {
  label?: string
  type?: 'separator'
  click?: () => void
}

/** 托盘右键菜单：唤回主窗口 + 退出（菜单结构独立成纯函数，便于单测钉住） */
export function buildTrayMenuTemplate(handlers: TrayMenuHandlers): TrayMenuItem[] {
  return [
    { label: '显示主窗口', click: handlers.showWindow },
    { type: 'separator' },
    { label: '退出应用', click: handlers.quit }
  ]
}

export interface AppTrayDeps {
  /** 创建托盘（实现方 new Tray(图标)） */
  createTray: () => TrayLike
  /** 用模板构建原生菜单（实现方 Menu.buildFromTemplate） */
  buildMenu: (template: TrayMenuItem[]) => unknown
  /** 悬浮提示文案（系统名称；创建与每次 ensure 时刷新） */
  getTooltip: () => string
  handlers: TrayMenuHandlers
}

export interface AppTrayController {
  /** 懒创建托盘（幂等；已创建时仅刷新提示文案）：最小化到托盘时调用 */
  ensure(): void
  /** 销毁托盘（退出前调用，避免 Windows 通知区残留图标） */
  destroy(): void
  isCreated(): boolean
}

/**
 * 托盘生命周期控制器。
 * 懒创建（只有用户用过「最小化到托盘」才出现图标），创建后保持到应用退出——
 * 不随窗口唤回销毁，避免隐藏/恢复来回切换时通知区图标闪烁。
 */
export function createAppTray(deps: AppTrayDeps): AppTrayController {
  let tray: TrayLike | null = null

  return {
    ensure(): void {
      if (tray) {
        tray.setToolTip(deps.getTooltip())
        return
      }
      const created = deps.createTray()
      created.setToolTip(deps.getTooltip())
      created.setContextMenu(deps.buildMenu(buildTrayMenuTemplate(deps.handlers)))
      created.on('click', deps.handlers.showWindow)
      created.on('double-click', deps.handlers.showWindow)
      tray = created
    },
    destroy(): void {
      tray?.destroy()
      tray = null
    },
    isCreated(): boolean {
      return tray !== null
    }
  }
}
