/**
 * 定时任务模板领域类型
 *
 * 字段语义与后端 `api/automation/template_schemas.py` 一致（camelCase 由后端
 * 别名序列化）。排期部分直接复用 `types/automation.ts` 的 `AutomationSchedule`，
 * 因为模板就是任务的一份完整预设。
 */

import { createDefaultSchedule, localDate } from './automation'
import type {
  AutomationPromptPart,
  AutomationSchedule,
  AutomationTaskDraft,
  ContextMode,
} from './automation'

/** 模板实体（后端 AutomationTemplateResponse） */
export interface ScheduleTemplate {
  id: string
  name: string
  description: string
  icon: string
  /** 类型，取值来自「参数配置」的 schedule_template_type 分组 */
  category: string
  /** 语义化版本号（如 1.3.0） */
  version: string
  promptText: string
  promptParts: AutomationPromptPart[]
  schedule: AutomationSchedule
  /** 排期摘要（列表卡片展示，后端算好） */
  freqSummary: string
  /** 有效期摘要 */
  validitySummary: string
  model: string | null
  customModelId: string | null
  providerId: string | null
  modelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: ContextMode
  skillIds: string[]
  kbIds: string[]
  workspaceId: string | null
  workspaceName: string | null
  allowNetwork: boolean
  allowShell: boolean
  fullAccess: boolean
  createdBy: string
  createdAt: number
  updatedAt: number
}

/**
 * 新建 / 更新模板的请求体。
 *
 * `version` 可以省略：省略表示「由服务端兜底」（新建从 1.0.0、编辑递增次版本）。
 * 编辑弹窗默认会把 `bumpMinorVersion(模板版本)` 的结果填好并允许手工修改，
 * 所以正常流程下都会带上这个字段。
 */
export interface ScheduleTemplateDraft {
  name: string
  description: string
  icon: string
  category: string
  version?: string | null
  promptText: string
  promptParts: AutomationPromptPart[]
  schedule: AutomationSchedule
  model: string | null
  customModelId: string | null
  providerId: string | null
  modelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: ContextMode
  skillIds: string[]
  kbIds: string[]
  workspaceId: string | null
  workspaceName: string | null
  allowNetwork: boolean
  allowShell: boolean
  fullAccess: boolean
}

/**
 * 分页列表响应。
 *
 * 注意分页信封是 snake_case（`page_size`，与专家/工具/技能列表一致），
 * 里面的 `items` 才是 camelCase 的领域对象。
 */
export interface ScheduleTemplateListResponse {
  items: ScheduleTemplate[]
  total: number
  page: number
  page_size: number
}

/** 列表查询参数 */
export interface ScheduleTemplateListParams {
  page?: number
  pageSize?: number
  keyword?: string
  category?: string
}

/** 模板类型选项（来自「参数配置」） */
export interface TemplateTypeOption {
  value: string
  label: string
}

/**
 * 由模板生成一份任务草稿（「添加到定时任务」用）。
 *
 * 模板存的是完整任务配置，这里逐一搬到任务上，来源标记为 `template` 并回填
 * `templateId`，便于任务侧知道它来自哪个模板。
 *
 * 「单次」模板要特别处理：模板里那个日期只是占位（模板本身不参与调度），
 * 建任务时必须换成**当天**，否则会生成一个日期已经过去的任务——
 * 这与改造前 `createDefaultSchedule()` 用 `localDate()` 兜底的行为一致。
 */
export function toTaskDraft(template: ScheduleTemplate): AutomationTaskDraft {
  const schedule: AutomationSchedule = {
    ...createDefaultSchedule(),
    ...template.schedule,
    weekDays: [...template.schedule.weekDays],
    weekIntervalDays: [...template.schedule.weekIntervalDays],
  }
  if (schedule.freqGroup === 'cycle' && schedule.cycleKind === 'once') {
    schedule.onceDate = localDate()
  }

  const promptText = template.promptText || template.description
  return {
    title: template.name,
    promptText,
    promptParts:
      template.promptParts.length > 0 ? template.promptParts : [{ type: 'text', text: promptText }],
    icon: template.icon,
    source: 'template',
    templateId: template.id,
    schedule,
    model: template.model,
    customModelId: template.customModelId,
    providerId: template.providerId,
    modelId: template.modelId,
    expertId: template.expertId,
    expertName: template.expertName,
    contextMode: template.contextMode,
    skillIds: [...template.skillIds],
    kbIds: [...template.kbIds],
    workspaceId: template.workspaceId,
    workspaceName: template.workspaceName,
    allowNetwork: template.allowNetwork,
    allowShell: template.allowShell,
    fullAccess: template.fullAccess,
  }
}

// 分页选项与默认值统一由 types/pagination.ts 提供（工具/技能/专家页共用同一套）
