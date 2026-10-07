/**
 * 主窗口关闭行为拦截（标题栏 ✕ / Alt+F4 / 任务栏右键「关闭窗口」走同一 close 事件）
 *
 * 三态配置（settings.json 的 ui.closeAction，主进程每次 close 时实时读取）：
 * - 'close' ：放行，窗口正常关闭（单窗口应用 → window-all-closed → app.quit()）
 * - 'tray'  ：拦截并最小化到托盘（隐藏窗口 + 任务栏右下角托盘图标，进程继续运行，
 *             agent/自动化不受影响；托盘菜单可唤回窗口或彻底退出）
 * - 'ask'   ：拦截并请求渲染层弹应用内确认框；用户选择后落盘、之后不再询问
 *
 * 纯逻辑模块：不引 electron 运行时（仅结构性窗口接口，便于单测注入假窗口）。
 */

export type CloseAction = 'ask' | 'tray' | 'close'
export type CloseChoice = 'tray' | 'close'

/** attach 所需的最小窗口能力（BrowserWindow 结构兼容；单测用假窗口） */
export interface CloseGuardWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  on(event: 'query-session-end', listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
  off(event: 'closed', listener: () => void): unknown
  webContents: { send(channel: string): void }
  isDestroyed(): boolean
  /** hide/minimize/isMinimized 供 index.ts 的 minimizeToTray 实现使用（托盘不可用时退化最小化） */
  isMinimized(): boolean
  hide(): void
  minimize(): void
  close(): void
}

export interface CloseBehaviorDeps {
  /** 读取当前关闭行为（主进程为权威；渲染层设置页改动即时生效） */
  getAction: () => CloseAction
  /** 用户本次选择落盘（同步）；抛错由状态机兜底捕获，落盘失败不阻断关闭 */
  persistChoice: (choice: CloseChoice) => void
  /** 请求渲染层弹确认框；返回 null = 取消/超时/渲染层不可用。**必须保证 settle** */
  askUser: (win: CloseGuardWindow) => Promise<CloseChoice | null>
  /** 最小化到托盘：确保托盘图标存在并隐藏窗口（index.ts 装配；失败应自行退化为最小化） */
  minimizeToTray: (win: CloseGuardWindow) => void
}

export interface WindowCloseBehavior {
  attach(win: CloseGuardWindow): void
  /** 应用级退出（before-quit / 用户菜单「退出应用」）时置位：此后 close 一律放行 */
  markQuitting(): void
  isQuitting(): boolean
}

/**
 * 关闭拦截状态机。
 *
 * 为什么必须有 quitting latch：close 里 preventDefault 会中止 app.quit()（quit 路径为
 * before-quit → 各窗 close → will-quit），若不区分「用户点 ✕」与「应用正在退出」，
 * 选了「最小化到托盘」的应用永远退不掉。Windows 关机/注销时 before-quit/will-quit 都不会触发
 * （Electron 文档明确），但窗口会收到 close —— 所以 latch 还要挂 query-session-end
 * （'session-end' 在 close 之后才发、且不在 App 接口上，不能替代），且绝不 preventDefault。
 */
export function createWindowCloseBehavior(deps: CloseBehaviorDeps): WindowCloseBehavior {
  let quitting = false

  function attach(win: CloseGuardWindow): void {
    // 本次关闭已获准（用户选了「直接关闭窗口」后重入 close 用）。
    // 与落盘解耦：落盘失败也必须能关，否则重入时又会走询问分支造成「点关闭没反应」。
    let allowClose = false
    // 询问单飞：弹窗未作答期间狂点 ✕ 只问一次
    let asking = false

    // 'query-session-end' 仅 win32 触发（其他平台注册无副作用）；此处不 preventDefault
    win.on('query-session-end', () => {
      quitting = true
    })

    win.on('close', (event) => {
      if (quitting || allowClose || win.isDestroyed()) return
      const action = deps.getAction()
      if (action === 'close') return

      event.preventDefault()
      if (action === 'tray') {
        deps.minimizeToTray(win)
        return
      }

      // action === 'ask'
      if (asking) return
      asking = true
      void (async () => {
        try {
          const choice = await deps.askUser(win)
          if (!choice) return // 取消：本次不关、不保存，下次再问
          // 先落盘（同步）再执行；落盘失败不阻断本次操作（状态机兜底，防异常逃逸到 unhandledRejection）
          try {
            deps.persistChoice(choice)
          } catch (err) {
            console.warn('[window] 关闭行为落盘失败:', err)
          }
          if (win.isDestroyed()) return
          if (choice === 'tray') {
            deps.minimizeToTray(win)
            return
          }
          allowClose = true
          win.close()
        } finally {
          asking = false
        }
      })()
    })
  }

  return {
    attach,
    markQuitting: () => {
      quitting = true
    },
    isQuitting: () => quitting
  }
}

export interface CloseConfirmBroker {
  /** 发起一次询问；已有在途询问时立即返回 null（正常路径由状态机单飞挡住） */
  request(): Promise<CloseChoice | null>
  /** 渲染层作答；返回是否命中在途询问（未命中 = 迟到/重复作答，静默忽略） */
  answer(choice: CloseChoice | null): boolean
  /** 退出/窗口销毁时收尾在途询问（按取消处理） */
  cancelPending(): void
}

/**
 * 询问应答 broker：渲染层经 IPC 作答 → 主进程 resolve 询问 Promise。
 * 超时兜底是必需品：渲染层崩溃/未订阅/重载都会让作答永不到达，
 * 若不 settle，该窗口之后所有 ✕ 会永久失效（asking 恒真）。
 */
export function createCloseConfirmBroker(timeoutMs = 15_000): CloseConfirmBroker {
  let pending: ((choice: CloseChoice | null) => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function settle(choice: CloseChoice | null): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const resolve = pending
    pending = null
    resolve?.(choice)
  }

  return {
    request(): Promise<CloseChoice | null> {
      if (pending) return Promise.resolve(null)
      return new Promise((resolve) => {
        pending = resolve
        timer = setTimeout(() => settle(null), timeoutMs)
      })
    },
    answer(choice: CloseChoice | null): boolean {
      if (!pending) return false
      settle(choice)
      return true
    },
    cancelPending(): void {
      settle(null)
    }
  }
}
