import type { ElectronAPI } from '@electron-toolkit/preload'

// 契约单一来源已迁移至 src/shared/contracts.ts（本文件只保留渲染层 Window 全局声明与兼容 re-export）。
// 新代码请直接 import from shared/contracts；存量 import 经 re-export 继续可用。
// 注：实测若把 preload/index.ts 的导入也直接指向 shared/contracts（并去掉本 re-export），
// vue-tsc 对渲染层（tsconfig.web）的类型解析会出现异常（42 例误报，机制未明）——保留这层薄转出规避。
export * from '../shared/contracts'
import type { KeWorkWindowApi } from '../shared/contracts'

declare global {
  interface Window {
    electron: ElectronAPI
    api: KeWorkWindowApi
  }
}
