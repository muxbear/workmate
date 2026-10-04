import { ref } from 'vue'

/**
 * 全局轻量 toast（单一实现）。
 *
 * 历史问题：10 个页面/组件各自维护 ref + 定时器 + 就地渲染 + 各自样式，时长/位置/z-index
 * 逐处漂移。收敛为：任意组件调 showToast，由 App.vue 中的 ToastHost 统一渲染。
 */
const toast = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

/** 显示一条 toast；重复调用重置计时（默认 1.8s，对齐历史页面级实现） */
export function showToast(text: string, durationMs = 1800): void {
  toast.value = text
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    toast.value = ''
  }, durationMs)
}

/** 当前 toast 文案（只读约定；仅 ToastHost 消费） */
export const toastMessage = toast
