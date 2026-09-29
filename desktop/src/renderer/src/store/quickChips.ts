/**
 * 「新建任务」欢迎态的场景 chip 配置（本地配置，localStorage 持久化）
 *
 * - 默认清单写在代码里（DEFAULT_QUICK_CHIPS）；用户删掉 chip 后落盘的是"仍然显示的
 *   label 清单"，之后以落盘清单为准（含顺序）。
 * - 没有落盘记录 → 用默认清单，这样后续新增的默认 chip 对老用户同样可见；
 *   全删光落盘 `[]`，必须与"没有配置"区分开，否则删掉的 chip 下次启动又回来了。
 * - 落盘清单里的未知 label（旧配置残留）直接忽略，不渲染空壳 chip。
 * - 想恢复默认：清掉 localStorage 的 `ke-work:quick-chips` 即可。
 */

export type QuickChipIcon = 'doc' | 'chart' | 'research' | 'video' | 'slides'

export interface QuickChip {
  icon: QuickChipIcon
  label: string
}

/** 默认 chip 清单（顺序即展示顺序） */
export const DEFAULT_QUICK_CHIPS: QuickChip[] = [
  { icon: 'doc', label: '文档处理' },
  { icon: 'research', label: '深度研究' },
  { icon: 'video', label: '视频生成' },
  { icon: 'slides', label: '幻灯片' },
  { icon: 'chart', label: '数据分析及可视化' }
]

const STORAGE_KEY = 'ke-work:quick-chips'

/** node 测试环境/localStorage 不可用时不抛错 */
function readStorage(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStorage(labels: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labels))
  } catch {
    // 存储满/被禁用：静默忽略，仅本次会话有效
  }
}

/** 读本地配置（未落盘过返回 null；坏 JSON/非数组一律按未配置处理） */
export function loadQuickChips(): QuickChip[] {
  const raw = readStorage()
  if (!raw) return DEFAULT_QUICK_CHIPS

  let labels: unknown
  try {
    labels = JSON.parse(raw)
  } catch {
    return DEFAULT_QUICK_CHIPS
  }
  if (!Array.isArray(labels)) return DEFAULT_QUICK_CHIPS

  return labels
    .map((label) => DEFAULT_QUICK_CHIPS.find((chip) => chip.label === label))
    .filter((chip): chip is QuickChip => !!chip)
}

/** 写本地配置（只存 label，图标等展示信息始终由默认清单提供） */
export function saveQuickChips(chips: QuickChip[]): void {
  writeStorage(chips.map((chip) => chip.label))
}
