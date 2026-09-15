/**
 * 组件渲染测试需要 import .vue 单文件组件。
 *
 * tsconfig.node.json 覆盖 tests/**，但渲染层的 .vue 类型由 vue-tsc（tsconfig.web.json）
 * 原生解析，plain tsc 不认；这里补一个最小声明，仅供测试引用组件。
 * 注意：本文件不在 tsconfig.web.json 的 include 内，因此不会影响渲染层本身的类型检查。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
