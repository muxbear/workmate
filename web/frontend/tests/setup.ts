import { config } from '@vue/test-utils'

// Mock localStorage and sessionStorage
const storageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(window, 'localStorage', { value: storageMock })
Object.defineProperty(window, 'sessionStorage', { value: storageMock })

// jsdom 没有 ResizeObserver，而 Element Plus 的 el-tabs / el-slider / el-select 等
// 组件会在挂载时用它——缺失时组件抛 `ResizeObserver is not defined`，测试直接失败，
// 报错信息还指向组件内部，很难看出是环境问题。这里给一个惰性实现（回调永远不触发，
// 因为 jsdom 里本来也没有真实尺寸变化）。
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    writable: true,
  })
}

// vue-i18n：组件里的 useI18n() 需要一个已安装的 i18n 实例，否则挂载即抛
// "Not installed"。**这一条是组件迁移到 i18n 的前置**——不注册的话，任何用了
// useI18n 的组件一被测试挂载就全挂（迭代 6 T6.6）。
//
// 用真实实例而不是桩：测试断言的是渲染出来的中文文案，而 zh-CN 就是默认语言，
// 所以迁移前后渲染结果逐字一致。
import i18n from '@/locales'

config.global.plugins = [...(config.global.plugins ?? []), i18n]

// jsdom 不实现 matchMedia，而响应式侧栏（ui store 的 initResponsiveSidebar）用它。
// 给一个可用的桩：默认按"宽屏"返回，测试可通过 window.__setViewport 改宽度。
// （照 ChatPlusMenu.vue 的既有实现——它是全仓唯一按视口驱动 UI 的地方。）
// 判"是不是函数"而不是 `'matchMedia' in window`：jsdom 里这个**属性存在但值是
// undefined**，用 `in` 判断会以为环境已经提供了、于是跳过安装，而组件那边一调用
// 就炸（或静默拿到 undefined）。这个坑实测踩过一次。
if (typeof window.matchMedia !== 'function') {
  type Listener = (e: MediaQueryListEvent) => void
  const registry = new Map<MediaQueryList, { query: string; listeners: Set<Listener> }>()
  let width = 1440

  const matchesOf = (query: string, w: number) => {
    const max = /max-width:\s*(\d+)px/.exec(query)
    const min = /min-width:\s*(\d+)px/.exec(query)
    if (max && w > Number(max[1])) return false
    if (min && w < Number(min[1])) return false
    return true
  }

  const makeList = (query: string) => {
    const listeners = new Set<Listener>()
    const list = {
      matches: matchesOf(query, width),
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: Listener) => listeners.add(cb),
      removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
      addListener: (cb: Listener) => listeners.add(cb),
      removeListener: (cb: Listener) => listeners.delete(cb),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
    registry.set(list, { query, listeners })
    return list
  }

  Object.defineProperty(window, 'matchMedia', { value: makeList, writable: true })
  /**
   * 测试用：改视口宽度并按各自 query 重新计算 matches 后通知监听者。
   * 桩必须**真的按新宽度算**——永远通知 `matches: false` 的话，"变窄即收起"
   * 这类用例根本测不出东西。
   */
  Object.defineProperty(window, '__setViewportWidth', {
    value: (next: number) => {
      width = next
      for (const [list, { query, listeners }] of registry) {
        const matches = matchesOf(query, next)
        ;(list as { matches: boolean }).matches = matches
        for (const cb of listeners) cb({ matches } as MediaQueryListEvent)
      }
    },
    writable: true,
  })
}
