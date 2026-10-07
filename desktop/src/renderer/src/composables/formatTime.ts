/**
 * 相对时间格式化（自 Home.vue 外提；侧栏会话行与空间管理页任务行共用）。
 * 规则：<1 分钟「刚刚」→ <1 小时「N分钟前」→ <1 天「N小时前」→ 昨天 → 7 天内「N天前」→ 绝对日期。
 */
export function formatRelativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
