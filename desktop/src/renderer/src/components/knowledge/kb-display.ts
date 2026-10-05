import type { KnowledgeFileIcon } from './knowledgeTree'

/**
 * 知识库列表展示助手（R6：自 KnowledgePage 外提，页面与 useCloudDocs 共用）。
 * 本地行与云端行走同一套规则：时间文案、文件图标、图标底色。
 */

/** 文件图标底色（与上传弹窗同一套色板） */
export const FILE_TINTS: Record<string, string> = {
  pdf: '#ef4444',
  doc: '#3b82f6',
  docx: '#3b82f6',
  xls: '#16a34a',
  xlsx: '#16a34a',
  csv: '#16a34a',
  ppt: '#e8793d',
  pptx: '#e8793d',
  md: '#168b7a',
  txt: '#168b7a'
}

/** 时间戳 → 列表文案：今天 HH:mm / 昨天 HH:mm / M 月 D 日 */
export function formatTimestamp(ts: number): string {
  if (!ts) return '—'
  const date = new Date(ts)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diffDay = Math.floor((startOfToday - date.getTime()) / 86400000)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (diffDay <= 0) return `今天 ${hm}`
  if (diffDay === 1) return `昨天 ${hm}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 扩展名 → 表格里的三套文件图标 */
export function pickFileIcon(ext: string): KnowledgeFileIcon {
  if (['csv', 'xls', 'xlsx'].includes(ext)) return 'file-spreadsheet'
  if (['doc', 'docx'].includes(ext)) return 'file-type-2'
  return 'file-text'
}
