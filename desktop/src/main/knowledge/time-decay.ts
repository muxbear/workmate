/**
 * 时间衰减：按文档导入时间对检索最终分数做半衰期加权（P7 增强层，默认关闭）。
 *
 * factor = 0.5 ** (ageDays / halfLifeDays)；halfLifeDays ≤ 0 = 关闭。
 * 事实源是文档的 uploaded_at（**导入时间**，不是内容日期 —— 桌面端尚未抽取内容时间）。
 * 缺失 uploadedAt 按 0 年龄处理；未来时间 clamp（factor ≤ 1，不放大）。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 单个时间点的衰减系数（1 = 不衰减） */
export function decayFactor(
  uploadedAt: number | undefined,
  now: number,
  halfLifeDays: number
): number {
  if (!(halfLifeDays > 0) || uploadedAt === undefined) return 1
  const ageMs = Math.max(0, now - uploadedAt)
  if (ageMs === 0) return 1
  return 0.5 ** (ageMs / (halfLifeDays * DAY_MS))
}

/** 对 score 应用时间衰减并按衰减后分数重新降序（返回新数组；关闭时原样返回） */
export function applyTimeDecay<T extends { score: number; uploadedAt?: number }>(
  hits: T[],
  now: number,
  halfLifeDays: number
): T[] {
  if (!(halfLifeDays > 0) || hits.length === 0) return hits
  return hits
    .map((hit) => ({ ...hit, score: hit.score * decayFactor(hit.uploadedAt, now, halfLifeDays) }))
    .sort((a, b) => b.score - a.score)
}
