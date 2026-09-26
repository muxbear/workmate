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
