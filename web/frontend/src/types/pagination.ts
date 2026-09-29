/**
 * 列表分页的公共约定。
 *
 * 各列表页底部统一用同一套 Element Plus 分页控件：
 * `total, sizes, prev, pager, next, jumper`（共 N 条 / 改每页条数 / 翻页 / 跳页），
 * 并统一关闭 `size="small"`（字号与页内正文同档，见 ScheduleTemplatesView）。
 *
 * 带上 6 是有意的：内置数据量都不大（工具 14、技能 6、专家 4、模板 12），
 * 若最小只能选 12，「翻页 / 跳页」在多数页面上永远只有一页，既用不上也看不出效果。
 */
export const PAGE_SIZE_OPTIONS = [6, 12, 24, 48] as const

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 12

/** 分页控件的 layout，三处保持一致 */
export const PAGINATION_LAYOUT = 'total, sizes, prev, pager, next, jumper'
