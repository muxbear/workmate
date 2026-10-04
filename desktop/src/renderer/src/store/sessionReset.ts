/**
 * 登出 / 会话失效时的域状态重置注册表。
 *
 * 各 store 模块加载时自注册 reset 函数（惰性取实例，避免模块级实例化）；
 * router 守卫与 Home 登出流程只调 resetUserSession()，新增 store 自注册即可接入，
 * 不再需要逐处补写 reset 调用（历史问题：同一组重置在 router 与 Home 各写一遍）。
 */
const resetters = new Set<() => void>()

/** 自注册一个域重置函数（Set 去重，重复注册幂等） */
export function registerResettable(reset: () => void): void {
  resetters.add(reset)
}

/** 依次执行全部注册的域重置；单个域失败不影响其余（记录后继续） */
export function resetUserSession(): void {
  for (const reset of resetters) {
    try {
      reset()
    } catch (err) {
      console.warn('[session-reset] 域重置失败:', err)
    }
  }
}
