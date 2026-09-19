import instance from './request'
import type {
  Skill,
  SkillCreateRequest,
  SkillRepoImportResponse,
  SkillRepoListResponse,
  SkillRepoSource,
} from '@/types/skill'

/** Backend paginated list response */
interface SkillListResponse {
  items: Skill[]
  total: number
  page: number
  page_size: number
}

/** Backend delete response */
interface SkillDeleteResponse {
  deleted_count: number
  failed_count: number
  results: { id: string; name: string; deleted: boolean; reason: string }[]
}

/** Backend upload response */
interface SkillsUploadResponse {
  skills_dir: string
  total: number
  valid_count: number
  invalid_count: number
  skipped_count: number
  results: { name: string; valid: boolean; errors: { field: string; message: string }[] }[]
  skipped: string[]
}

export async function fetchSkills(params?: {
  category?: string
  page?: number
  page_size?: number
  enabled?: boolean
}): Promise<SkillListResponse> {
  const res = await instance.get('/skill/list', { params })
  return res.data.data as SkillListResponse
}

export async function fetchSkill(id: string): Promise<Skill> {
  const res = await instance.get(`/skill/${id}`)
  return res.data.data as Skill
}

export async function createSkill(data: SkillCreateRequest): Promise<Skill> {
  const res = await instance.post('/skill', data)
  return res.data.data as Skill
}

export async function updateSkill(
  id: string,
  data: Partial<SkillCreateRequest & { enabled: boolean }>,
): Promise<Skill> {
  const res = await instance.put(`/skill/${id}`, data)
  return res.data.data as Skill
}

export async function deleteSkill(id: string): Promise<SkillDeleteResponse> {
  const res = await instance.delete(`/skill/${id}`)
  return res.data.data as SkillDeleteResponse
}

export async function deleteSkillsBatch(ids: string[]): Promise<SkillDeleteResponse> {
  const res = await instance.delete('/skill/batch', { data: { ids } })
  return res.data.data as SkillDeleteResponse
}

export async function toggleSkill(id: string, enabled: boolean): Promise<Skill> {
  const res = await instance.patch(`/skill/${id}/toggle`, { enabled })
  return res.data.data as Skill
}

export async function uploadSkills(file: File): Promise<SkillsUploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await instance.post('/skill/upload_skills', formData)
  return res.data.data as SkillsUploadResponse
}

export async function searchSkills(
  name: string,
  params?: { page?: number; page_size?: number; category?: string; enabled?: boolean },
): Promise<SkillListResponse> {
  const res = await instance.get('/skill/search', { params: { name, ...params } })
  return res.data.data as SkillListResponse
}

/** 获取后端注册的权威技能仓库来源 */
export async function fetchRepoSkillSources(): Promise<SkillRepoSource[]> {
  const res = await instance.get('/skill/repo/sources')
  return (res.data.data?.sources ?? []) as SkillRepoSource[]
}

/** 抓取指定来源的技能榜单（服务端带缓存与限流保护） */
export async function fetchRepoSkills(params: {
  source: string
  keyword?: string
  page?: number
  page_size?: number
  refresh?: boolean
}): Promise<SkillRepoListResponse> {
  const res = await instance.get('/skill/repo/list', { params })
  return res.data.data as SkillRepoListResponse
}

/** 把榜单中选中的技能导入到 workspace/skills_upload/ 并入库 */
export async function importRepoSkills(
  source: string,
  skillIds: string[],
): Promise<SkillRepoImportResponse> {
  const res = await instance.post('/skill/repo/import', { source, skill_ids: skillIds })
  return res.data.data as SkillRepoImportResponse
}
