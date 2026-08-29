/**
 * Expert API — 专家管理接口调用
 *
 * 注意：后端 API 尚未实现，当前使用 mock 数据。
 * 后端实现后移除 mock 相关逻辑即可。
 */
import instance from './request'
import type {
  Expert,
  ExpertCreateRequest,
  ExpertUpdateRequest,
  ExpertProfileUpdateRequest,
  ExpertConfigUpdateRequest,
  ExpertListParams,
  ExpertListResponse,
  ExpertCategory,
  FeaturedScene,
} from '@/types/expert'

/* ------------------------------------------------------------------ */
/*  snake_case -> camelCase 转换                                       */
/* ------------------------------------------------------------------ */

function toToolBrief(raw: Record<string, unknown>): NonNullable<Expert['tools'][number]> {
  return {
    id: raw.id as string,
    name: raw.name as string,
    displayName: (raw.display_name as string) || raw.name as string,
    toolType: ((raw.tool_type as string) || 'function') as 'function' | 'mcp' | 'plugin',
    category: (raw.category as string) || 'other',
    icon: (raw.icon as string) || '',
  }
}

function toExpertSkillBrief(raw: Record<string, unknown>): NonNullable<Expert['skills'][number]> {
  return {
    id: raw.id as string,
    name: raw.name as string,
    description: (raw.description as string) || '',
    category: (raw.category as string) || 'custom',
    icon: (raw.icon as string) || '',
    enabled: (raw.enabled as boolean) ?? true,
  }
}

function toMcpConfigBrief(raw: Record<string, unknown>): NonNullable<Expert['mcpConfigs'][number]> {
  return {
    mcpToolId: (raw.mcp_tool_id as string) || '',
    mcpToolName: (raw.mcp_tool_name as string) || '',
    config: (raw.config as Record<string, unknown>) || {},
    enabled: (raw.enabled as boolean) ?? true,
  }
}

function toExpert(raw: Record<string, unknown>): Expert {
  return {
    id: raw.id as string,
    name: raw.name as string,
    title: (raw.title as string) || '',
    description: (raw.description as string) || '',
    category: (raw.category as string) || 'custom',
    tags: (raw.tags as string[]) || [],
    icon: (raw.icon as string) || '',
    color: (raw.color as string) || '',
    initials: (raw.initials as string) || '',
    avatarUrl: raw.avatar_url as string | undefined,
    rating: (raw.rating as number) ?? 0,
    usageCount: (raw.usage_count as number) ?? 0,
    featured: (raw.featured as boolean) ?? false,
    scene: raw.scene as string | undefined,
    sortOrder: (raw.sort_order as number) ?? 0,
    isPublished: (raw.is_published as boolean) ?? true,
    status: ((raw.status as string) || 'inactive') as 'active' | 'inactive' | 'error',
    systemPrompt: (raw.system_prompt as string) || '',
    providerId: raw.provider_id as string | undefined,
    modelId: raw.model_id as string | undefined,
    tools: ((raw.tools as Record<string, unknown>[]) || []).map(toToolBrief),
    skills: ((raw.skills as Record<string, unknown>[]) || []).map(toExpertSkillBrief),
    mcpConfigs: ((raw.mcp_configs as Record<string, unknown>[]) || []).map(toMcpConfigBrief),
    files: (raw.files as string[]) || [],
    createdAt: raw.created_at as string,
    updatedAt: raw.updated_at as string,
  }
}

function toCreatePayload(data: ExpertCreateRequest): Record<string, unknown> {
  return {
    name: data.name,
    title: data.title,
    description: data.description,
    system_prompt: data.systemPrompt,
    category: data.category,
    tags: data.tags,
    icon: data.icon,
    color: data.color,
    initials: data.initials,
    provider_id: data.providerId || null,
    model_id: data.modelId || null,
    tool_names: data.toolNames,
    skill_ids: data.skillIds,
    mcp_configs: data.mcpConfigs,
    featured: data.featured,
    scene: data.scene || null,
  }
}

function toUpdatePayload(data: ExpertUpdateRequest): Record<string, unknown> {
  return {
    name: data.name,
    title: data.title,
    description: data.description,
    system_prompt: data.systemPrompt,
    provider_id: data.providerId || null,
    model_id: data.modelId || null,
  }
}

function toProfilePayload(data: ExpertProfileUpdateRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (data.title !== undefined) out.title = data.title
  if (data.category !== undefined) out.category = data.category
  if (data.tags !== undefined) out.tags = data.tags
  if (data.icon !== undefined) out.icon = data.icon
  if (data.color !== undefined) out.color = data.color
  if (data.initials !== undefined) out.initials = data.initials
  if (data.avatarUrl !== undefined) out.avatar_url = data.avatarUrl
  if (data.featured !== undefined) out.featured = data.featured
  if (data.scene !== undefined) out.scene = data.scene
  if (data.sortOrder !== undefined) out.sort_order = data.sortOrder
  if (data.isPublished !== undefined) out.is_published = data.isPublished
  return out
}

function toConfigPayload(data: ExpertConfigUpdateRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (data.systemPrompt !== undefined) out.system_prompt = data.systemPrompt
  if (data.providerId !== undefined) out.provider_id = data.providerId || null
  if (data.modelId !== undefined) out.model_id = data.modelId || null
  if (data.toolNames !== undefined) out.tool_names = data.toolNames
  if (data.skillIds !== undefined) out.skill_ids = data.skillIds
  if (data.mcpConfigs !== undefined) out.mcp_configs = data.mcpConfigs
  return out
}

/* ------------------------------------------------------------------ */
/*  API 函数                                                           */
/* ------------------------------------------------------------------ */

export async function fetchExperts(params: ExpertListParams): Promise<ExpertListResponse> {
  const res = await instance.get('/experts', {
    params: {
      page: params.page,
      page_size: params.pageSize,
      keyword: params.keyword || undefined,
      category: params.category || undefined,
      featured: params.featured,
      status: params.status,
      sort: params.sort,
    },
  })
  const data = res.data.data as Record<string, unknown>
  return {
    items: ((data.items as Record<string, unknown>[]) || []).map(toExpert),
    total: (data.total as number) || 0,
    page: (data.page as number) || 1,
    pageSize: (data.page_size as number) || 20,
  }
}

export async function fetchExpertCategories(): Promise<ExpertCategory[]> {
  const res = await instance.get('/experts/categories')
  return (res.data.data as ExpertCategory[]) || []
}

export async function fetchFeaturedExperts(): Promise<{
  scenes: FeaturedScene[]
  experts: Expert[]
}> {
  const res = await instance.get('/experts/featured')
  const data = res.data.data as Record<string, unknown>
  return {
    scenes: ((data.scenes as Record<string, unknown>[]) || []).map((raw) => ({
      id: raw.id as string,
      label: raw.label as string,
      color: raw.color as string,
      expertIds: (raw.expert_ids as string[]) || [],
    })),
    experts: ((data.experts as Record<string, unknown>[]) || []).map(toExpert),
  }
}

export async function getExpert(id: string): Promise<Expert> {
  const res = await instance.get(`/experts/${id}`)
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function createExpert(data: ExpertCreateRequest): Promise<Expert> {
  const res = await instance.post('/experts', toCreatePayload(data))
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function updateExpert(id: string, data: ExpertUpdateRequest): Promise<Expert> {
  const res = await instance.put(`/experts/${id}`, toUpdatePayload(data))
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function updateExpertProfile(
  id: string,
  data: ExpertProfileUpdateRequest,
): Promise<Expert> {
  const res = await instance.put(`/experts/${id}/profile`, toProfilePayload(data))
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function updateExpertConfig(
  id: string,
  data: ExpertConfigUpdateRequest,
): Promise<Expert> {
  const res = await instance.put(`/experts/${id}/config`, toConfigPayload(data))
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function deleteExpert(id: string): Promise<void> {
  await instance.delete(`/experts/${id}`)
}

export async function toggleExpertStatus(id: string): Promise<Expert> {
  const res = await instance.patch(`/experts/${id}/status`)
  return toExpert(res.data.data as Record<string, unknown>)
}

export async function cloneExpert(id: string): Promise<Expert> {
  const res = await instance.post(`/experts/${id}/clone`)
  return toExpert(res.data.data as Record<string, unknown>)
}
