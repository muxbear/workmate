/** 技能实体 */
export interface Skill {
  id: string
  name: string
  description: string
  icon: string
  category: string
  prompt: string
  enabled: boolean
  is_builtin: boolean
  valid: boolean
  source: string
  license: string
  validation_errors: string
  created_at: string
  updated_at: string
}

/** 创建/更新技能请求 */
export interface SkillCreateRequest {
  name: string
  description?: string
  icon?: string
  category?: string
  prompt?: string
}

/** 来源中文映射 */
export const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置',
  local: '本地上传',
  'anthropic-official': 'Anthropic 官方',
  superpowers: 'Superpowers',
  clawhub: 'ClawHub',
}

/** 分类元数据（与工具页分类展示规范保持一致） */
export interface SkillCategoryMeta {
  label: string
  icon: string
  color: string
  bg: string
  border: string
}

/** 内置分类展示顺序 */
export const CATEGORY_ORDER = ['search', 'code', 'creative', 'analysis', 'tools', 'custom'] as const

/** 技能功能分类映射 */
export const CATEGORY_META: Record<string, SkillCategoryMeta> = {
  search: {
    label: '搜索',
    icon: 'Search',
    color: 'var(--color-tool-cyan)',
    bg: 'rgba(6, 182, 212, 0.08)',
    border: 'rgba(6, 182, 212, 0.22)',
  },
  code: {
    label: '代码',
    icon: 'Code2',
    color: 'var(--color-tool-blue)',
    bg: 'rgba(59, 130, 246, 0.08)',
    border: 'rgba(59, 130, 246, 0.22)',
  },
  creative: {
    label: '创意',
    icon: 'Palette',
    color: 'var(--color-tool-pink)',
    bg: 'rgba(236, 72, 153, 0.08)',
    border: 'rgba(236, 72, 153, 0.22)',
  },
  analysis: {
    label: '分析',
    icon: 'BarChart3',
    color: 'var(--color-tool-purple)',
    bg: 'rgba(168, 85, 247, 0.08)',
    border: 'rgba(168, 85, 247, 0.22)',
  },
  tools: {
    label: '工具',
    icon: 'Wrench',
    color: 'var(--color-tool-amber)',
    bg: 'rgba(245, 158, 11, 0.08)',
    border: 'rgba(245, 158, 11, 0.22)',
  },
  custom: {
    label: '自定义',
    icon: 'Zap',
    color: 'var(--color-tool-gray)',
    bg: 'rgba(148, 163, 184, 0.08)',
    border: 'rgba(148, 163, 184, 0.22)',
  },
}

/** 获取分类元数据，未知分类回退为灰色样式并保留原始分类名 */
export function getSkillCategoryMeta(category: string): SkillCategoryMeta {
  return (
    CATEGORY_META[category] || {
      label: category || '其他',
      icon: 'Wrench',
      color: 'var(--color-tool-gray)',
      bg: 'rgba(148, 163, 184, 0.08)',
      border: 'rgba(148, 163, 184, 0.22)',
    }
  )
}

/** 分类中文映射（兼容手动创建等场景） */
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_META).map(([key, meta]) => [key, meta.label]),
)

/** 技能仓库来源（后端注册的权威技能仓库） */
export interface SkillRepoSource {
  id: string
  name: string
  description: string
  authority: string
  repository: string
  homepage: string
  skills_path: string
}

/** 技能仓库榜单条目 */
export interface SkillRepoSkill {
  id: string
  name: string
  dir_name: string
  description: string
  category: string
  license: string
  source: string
  source_name: string
  repository: string
  popularity: number
  rank: number
  install_url: string
  updated_at: string
}

/** 技能仓库榜单响应 */
export interface SkillRepoListResponse {
  source: string
  source_name: string
  rank_basis: string
  fetched_at: string
  total: number
  page: number
  page_size: number
  items: SkillRepoSkill[]
}

/** 从技能仓库导入技能的结果 */
export interface SkillRepoImportResponse {
  total: number
  valid_count: number
  invalid_count: number
  skipped_count: number
  results: { name: string; valid: boolean; errors: { field: string; message: string }[] }[]
  skipped: string[]
}
