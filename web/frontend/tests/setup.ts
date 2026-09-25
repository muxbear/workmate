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
