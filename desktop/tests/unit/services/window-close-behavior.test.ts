import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsStore } from '../../../src/main/settings/SettingsStore'
import {
  createCloseConfirmBroker,
  createWindowCloseBehavior,
  type CloseAction,
  type CloseChoice,
  type CloseGuardWindow
} from '../../../src/main/services/windowCloseBehavior'

/**
 * 主窗口关闭行为状态机 + 询问应答 broker 单测。
 *
 * 覆盖核心交互语义：首次询问并记住 / 取消不保存下次再问 / 已保存直通 /
 * 退出中（before-quit、Windows 关机）放行 / 单飞防重入 / 落盘失败仍可关闭。
 */

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'ke-close-behavior-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

/** 假窗口：模拟 close 事件可 preventDefault；未被拦截则销毁并发 closed */
class FakeWin {
  destroyed = false
  minimized = false
  hidden = false
  minimizeCalls = 0
  closeCalls = 0
  closePreventedCount = 0
  sent: string[] = []
  webContents = {
    send: (channel: string): void => {
      this.sent.push(channel)
    }
  }

  private listeners = new Map<string, Set<(...args: never[]) => void>>()

  on(event: string, listener: (...args: never[]) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  once(event: string, listener: (...args: never[]) => void): this {
    const wrapper = (...args: never[]): void => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      ;(listener as (...a: unknown[]) => void)(...args)
    }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  minimize(): void {
    this.minimizeCalls++
    this.minimized = true
  }
  hide(): void {
    this.hidden = true
  }
  /** 与真实语义一致：未被 preventDefault 则窗口销毁（closed 事件） */
  close(): void {
    this.closeCalls++
    let prevented = false
    this.emit('close', {
      preventDefault: (): void => {
        prevented = true
        this.closePreventedCount++
      }
    })
    if (!prevented) {
      this.destroyed = true
      this.emit('closed')
    }
  }
}

const asGuardWindow = (win: FakeWin): CloseGuardWindow => win as unknown as CloseGuardWindow

/** 等到状态机的异步链（askUser → 落盘 → 动作）跑完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface TestHarness {
  store: SettingsStore
  askUser: ReturnType<typeof vi.fn>
  minimizeToTray: ReturnType<typeof vi.fn>
  behavior: ReturnType<typeof createWindowCloseBehavior>
  win: FakeWin
  /** 模拟渲染层作答（resolve 在途询问） */
  answer: (choice: CloseChoice | null) => void
}

function setup(options?: { persistFails?: boolean }): TestHarness {
  const store = new SettingsStore(baseDir)
  let resolveAsk: ((choice: CloseChoice | null) => void) | null = null
  const askUser = vi.fn(
    () =>
      new Promise<CloseChoice | null>((resolve) => {
        resolveAsk = resolve
      })
  )
  const minimizeToTray = vi.fn()
  const behavior = createWindowCloseBehavior({
    getAction: () => store.get('ui.closeAction') as CloseAction,
    persistChoice: (choice) => {
      if (options?.persistFails) throw new Error('disk full')
      store.set('ui.closeAction', choice)
    },
    askUser,
    minimizeToTray
  })
  const win = new FakeWin()
  behavior.attach(asGuardWindow(win))
  return {
    store,
    askUser,
    minimizeToTray,
    behavior,
    win,
    answer: (choice: CloseChoice | null): void => resolveAsk?.(choice)
  }
}

describe('createWindowCloseBehavior（关闭拦截状态机）', () => {
  it('首次询问选「最小化到托盘」：拦截 + 落盘 + 隐藏到托盘', async () => {
    const { store, askUser, minimizeToTray, win, answer } = setup()
    win.close()
    expect(win.closePreventedCount).toBe(1)
    expect(win.destroyed).toBe(false)
    expect(askUser).toHaveBeenCalledTimes(1)

    answer('tray')
    await flush()
    expect(store.get('ui.closeAction')).toBe('tray')
    expect(minimizeToTray).toHaveBeenCalledTimes(1)
    expect(win.destroyed).toBe(false)
  })

  it('首次询问选「直接关闭窗口」：落盘 + 本次放行关闭', async () => {
    const { store, minimizeToTray, win, answer } = setup()
    win.close()
    answer('close')
    await flush()
    expect(store.get('ui.closeAction')).toBe('close')
    expect(win.closeCalls).toBe(2) // 用户触发 1 次 + 状态机放行 1 次
    expect(win.destroyed).toBe(true)
    expect(minimizeToTray).not.toHaveBeenCalled()
  })

  it('取消（null）：不落盘、不关、不进托盘；下次关闭继续询问', async () => {
    const { store, askUser, minimizeToTray, win, answer } = setup()
    win.close()
    answer(null)
    await flush()
    expect(store.get('ui.closeAction')).toBe('ask')
    expect(win.destroyed).toBe(false)
    expect(minimizeToTray).not.toHaveBeenCalled()

    win.close()
    expect(askUser).toHaveBeenCalledTimes(2)
  })

  it('已保存「最小化到托盘」：再次关闭直接进托盘，不再询问', async () => {
    const { store, askUser, minimizeToTray, win } = setup()
    store.set('ui.closeAction', 'tray')
    win.close()
    expect(win.closePreventedCount).toBe(1)
    expect(minimizeToTray).toHaveBeenCalledTimes(1)
    expect(askUser).not.toHaveBeenCalled()
  })

  it('已保存「直接关闭窗口」：close 不拦截', () => {
    const { store, askUser, win } = setup()
    store.set('ui.closeAction', 'close')
    win.close()
    expect(win.closePreventedCount).toBe(0)
    expect(win.destroyed).toBe(true)
    expect(askUser).not.toHaveBeenCalled()
  })

  it('markQuitting 后（before-quit / 退出应用）：ask 也直接放行', () => {
    const { behavior, askUser, win } = setup()
    behavior.markQuitting()
    win.close()
    expect(win.closePreventedCount).toBe(0)
    expect(win.destroyed).toBe(true)
    expect(askUser).not.toHaveBeenCalled()
  })

  it('Windows 关机/注销（query-session-end）：放行后续 close，不弹询问', () => {
    const { askUser, win } = setup()
    win.emit('query-session-end', { preventDefault: (): void => {} })
    win.close()
    expect(win.closePreventedCount).toBe(0)
    expect(win.destroyed).toBe(true)
    expect(askUser).not.toHaveBeenCalled()
  })

  it('弹窗未作答期间连点关闭：只询问一次（单飞）', async () => {
    const { askUser, minimizeToTray, win, answer } = setup()
    win.close()
    win.close()
    win.close()
    expect(askUser).toHaveBeenCalledTimes(1)

    answer('tray')
    await flush()
    expect(minimizeToTray).toHaveBeenCalledTimes(1)
  })

  it('落盘抛错：选「直接关闭窗口」仍能关闭（不阻断、不死锁）', async () => {
    const { win, answer } = setup({ persistFails: true })
    win.close()
    answer('close')
    await flush()
    expect(win.destroyed).toBe(true)
  })

  it('窗口已销毁后收到 close：直接放行不抛错', () => {
    const { win } = setup()
    win.destroyed = true
    win.close()
    expect(win.closePreventedCount).toBe(0)
  })
})

describe('createCloseConfirmBroker（询问应答 broker）', () => {
  it('作答命中：resolve 选择且 answer 返回 true；重复作答未命中', async () => {
    const broker = createCloseConfirmBroker()
    const asked = broker.request()
    expect(broker.answer('tray')).toBe(true)
    expect(await asked).toBe('tray')
    expect(broker.answer('close')).toBe(false)
  })

  it('超时兜底：无作答按取消（null）收尾', async () => {
    const broker = createCloseConfirmBroker(10)
    const asked = broker.request()
    expect(await asked).toBeNull()
  })

  it('在途询问期间再次 request：立即返回 null（不排队）', async () => {
    const broker = createCloseConfirmBroker()
    const first = broker.request()
    expect(await broker.request()).toBeNull()
    broker.answer('close')
    expect(await first).toBe('close')
  })

  it('cancelPending：在途询问立即按取消收尾', async () => {
    const broker = createCloseConfirmBroker()
    const asked = broker.request()
    broker.cancelPending()
    expect(await asked).toBeNull()
    expect(broker.answer('tray')).toBe(false)
  })
})
