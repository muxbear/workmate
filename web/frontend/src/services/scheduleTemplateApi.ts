/**
 * 定时任务模板接口 — 后端 /api/automation
 *
 * 模板是任务的一份完整预设：列表分页 + 类型筛选，以及模板的增删改。
 * 类型选项与模板同域，取自「参数配置」的 schedule_template_type 分组。
 */
import instance from './request'
import type {
  ScheduleTemplate,
  ScheduleTemplateDraft,
  ScheduleTemplateListParams,
  ScheduleTemplateListResponse,
  TemplateTypeOption,
} from '@/types/scheduleTemplate'

const BASE = '/automation/templates'

/** 分页列出模板，支持关键词与类型筛选 */
export async function fetchTemplates(
  params: ScheduleTemplateListParams = {},
): Promise<ScheduleTemplateListResponse> {
  const res = await instance.get(BASE, {
    params: {
      // 分页信封与请求参数都是 snake_case（与专家/工具/技能列表一致）
      page: params.page ?? 1,
      page_size: params.pageSize ?? 20,
      keyword: params.keyword || undefined,
      category: params.category || undefined,
    },
  })
  return res.data.data as ScheduleTemplateListResponse
}

/** 单个模板（编辑回填） */
export async function fetchTemplate(id: string): Promise<ScheduleTemplate> {
  const res = await instance.get(BASE + '/' + encodeURIComponent(id))
  return res.data.data as ScheduleTemplate
}

/** 新建模板（不传 version 时后端从 1.0.0 起步） */
export async function createTemplate(draft: ScheduleTemplateDraft): Promise<ScheduleTemplate> {
  const res = await instance.post(BASE, draft)
  return res.data.data as ScheduleTemplate
}

/** 更新模板（不传 version 时后端递增次版本） */
export async function updateTemplate(
  id: string,
  draft: ScheduleTemplateDraft,
): Promise<ScheduleTemplate> {
  const res = await instance.put(BASE + '/' + encodeURIComponent(id), draft)
  return res.data.data as ScheduleTemplate
}

/** 删除模板（软删除） */
export async function deleteTemplate(id: string): Promise<void> {
  await instance.delete(BASE + '/' + encodeURIComponent(id))
}

/** 可选的模板类型（来自「参数配置」，未配置时为空列表） */
export async function fetchTemplateTypes(): Promise<TemplateTypeOption[]> {
  const res = await instance.get('/automation/template-types')
  return (res.data.data ?? []) as TemplateTypeOption[]
}
