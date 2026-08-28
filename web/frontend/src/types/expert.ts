/** 专家展示元数据中的工具简要信息 */
export interface ToolBrief {
  id: string
  name: string
  displayName: string
  toolType: 'function' | 'mcp' | 'plugin'
  category: string
  icon: string
}

/** MCP 配置简要信息 */
export interface McpConfigBrief {
  mcpToolId: string
  mcpToolName: string
  config: Record<string, unknown>
  enabled: boolean
}

/** 技能简要信息（复用 agent.ts 的 SkillBrief） */
export interface ExpertSkillBrief {
  id: string
  name: string
  description: string
  category: string
  icon: string
  enabled: boolean
}

/** 专家实体 */
export interface Expert {
  id: string
  name: string
  title: string
  description: string
  category: string
  tags: string[]
  icon: string
  color: string
  initials: string
  avatarUrl?: string
  rating: number
  usageCount: number
  featured: boolean
  scene?: string
  sortOrder: number
  isPublished: boolean
  status: 'active' | 'inactive' | 'error'
  systemPrompt: string
  providerId?: string
  modelId?: string
  tools: ToolBrief[]
  skills: ExpertSkillBrief[]
  mcpConfigs: McpConfigBrief[]
  files: string[]
  createdAt: string
  updatedAt: string
}

/** 创建专家请求 */
export interface ExpertCreateRequest {
  name: string
  title: string
  description: string
  systemPrompt: string
  category: string
  tags: string[]
  icon: string
  color: string
  initials: string
  providerId?: string
  modelId?: string
  toolNames: string[]
  skillIds: string[]
  mcpConfigs: McpConfigItem[]
  featured: boolean
  scene?: string
}

/** 更新专家基础信息 */
export interface ExpertUpdateRequest {
  name: string
  title: string
  description: string
  systemPrompt: string
  providerId?: string
  modelId?: string
}

/** 更新展示元数据 */
export interface ExpertProfileUpdateRequest {
  title?: string
  category?: string
  tags?: string[]
  icon?: string
  color?: string
  initials?: string
  avatarUrl?: string
  featured?: boolean
  scene?: string
  sortOrder?: number
  isPublished?: boolean
}

/** MCP 配置项 */
export interface McpConfigItem {
  mcpToolId: string
  config: Record<string, unknown>
  enabled: boolean
}

/** 批量更新配置 */
export interface ExpertConfigUpdateRequest {
  systemPrompt?: string
  providerId?: string
  modelId?: string
  toolNames?: string[]
  skillIds?: string[]
  mcpConfigs?: McpConfigItem[]
}

/** 精选场景 */
export interface FeaturedScene {
  id: string
  label: string
  color: string
  expertIds: string[]
}

/** 分类信息 */
export interface ExpertCategory {
  key: string
  label: string
  count: number
}

/** 列表查询参数 */
export interface ExpertListParams {
  page: number
  pageSize: number
  keyword?: string
  category?: string
  featured?: boolean
  status?: string
  sort?: 'rating' | 'usage' | 'recent' | 'name'
}

/** 列表响应 */
export interface ExpertListResponse {
  items: Expert[]
  total: number
  page: number
  pageSize: number
}

/** 分类映射 */
export const EXPERT_CATEGORY_LABELS: Record<string, string> = {
  content_creation: '内容创作',
  legal_tax: '法律财税',
  tech_rnd: '技术研发',
  product_design: '产品设计',
  startup_invest: '创业投资',
  sme_ops: '小微企业',
  ai_tools: 'AI工具专家',
  spc: 'SPC',
  custom: '自定义',
}

/** 分类筛选列表 */
export const EXPERT_CATEGORY_FILTERS = [
  { key: '', label: '全部' },
  { key: 'content_creation', label: '内容创作' },
  { key: 'legal_tax', label: '法律财税' },
  { key: 'tech_rnd', label: '技术研发' },
  { key: 'product_design', label: '产品设计' },
  { key: 'startup_invest', label: '创业投资' },
  { key: 'sme_ops', label: '小微企业' },
  { key: 'ai_tools', label: 'AI工具专家' },
  { key: 'spc', label: 'SPC' },
]

/** 状态标签 */
export const EXPERT_STATUS_LABELS: Record<string, string> = {
  active: '已启用',
  inactive: '已停用',
  error: '错误',
}

/** 预设头像颜色 */
export const EXPERT_COLORS = [
  'linear-gradient(135deg,#f59e0b,#d97706)',
  'linear-gradient(135deg,#6366f1,#4f46e5)',
  'linear-gradient(135deg,#0891b2,#0e7490)',
  'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  'linear-gradient(135deg,#f97316,#ea580c)',
  'linear-gradient(135deg,#10b981,#059669)',
  'linear-gradient(135deg,#06b6d4,#0891b2)',
  'linear-gradient(135deg,#ec4899,#db2777)',
]
