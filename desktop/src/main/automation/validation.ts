import type { MessagePart } from '../../preload/index.d'
import type {
  ContextMode,
  CycleKind,
  FreqGroup,
  IntervalKind,
  NormalizedTaskDraft,
  TaskSchedule,
  ValidityMode
} from './types'
import {
  buildFreqSummary,
  buildValiditySummary,
  normalizeWeekDays,
  validityBounds
} from './AutomationSchedule'

const MAX_TITLE = 100
const MAX_PROMPT_TEXT = 20000
const MAX_PARTS = 50
const MAX_SKILLS = 50
const MAX_LABEL = 200

const FREQ_GROUPS: FreqGroup[] = ['cycle', 'interval']
const CYCLE_KINDS: CycleKind[] = ['once', 'daily', 'weekly', 'monthly', 'yearly']
const INTERVAL_KINDS: IntervalKind[] = ['weekly', 'hourly']
const VALIDITY_MODES: ValidityMode[] = ['forever', 'range']
const CONTEXT_MODES: ContextMode[] = ['default', 'local', 'knowledge']

/** 必填字符串（去空格 + 长度上限） */
export function asText(raw: unknown, label: string, maxLen: number = MAX_LABEL): string {
  if (typeof raw !== 'string') throw new Error(label + '类型错误')
  const text = raw.trim()
  if (!text) throw new Error(label + '不能为空')
  if (text.length > maxLen) throw new Error(label + '长度超出限制')
  return text
}

/** 可选字符串（空字符串按未填写处理） */
export function asOptionalText(
  raw: unknown,
  label: string,
  maxLen: number = MAX_LABEL
): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new Error(label + '类型错误')
  const text = raw.trim()
  if (!text) return null
  if (text.length > maxLen) throw new Error(label + '长度超出限制')
  return text
}

/** 布尔值（非法时取默认） */
export function asBool(raw: unknown, def: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  return def
}

/** 从白名单里取枚举值 */
export function asEnum<T extends string>(raw: unknown, label: string, allowed: T[], def: T): T {
  if (typeof raw === 'string' && (allowed as string[]).includes(raw)) return raw as T
  if (raw === undefined || raw === null) return def
  throw new Error(label + '取值非法')
}

/** 字符串 id 列表（去重 + 数量上限） */
export function asIdList(raw: unknown, label: string, max: number): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(label + '类型错误')
  if (raw.length > max) throw new Error(label + '数量超出限制')
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(label + '存在非法项')
    const text = item.trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** 数字字段（取整 + 区间钳制） */
export function asInt(raw: unknown, _label: string, def: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return def
  return Math.min(Math.max(Math.floor(value), min), max)
}

/** 提示词部件（文本段 / 文件段） */
export function asMessageParts(raw: unknown): MessagePart[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('提示词内容类型错误')
  if (raw.length > MAX_PARTS) throw new Error('提示词部件数量超出限制')
  const parts: MessagePart[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new Error('提示词部件格式错误')
    const row = item as { type?: unknown; text?: unknown; path?: unknown }
    if (row.type === 'text') {
      if (typeof row.text !== 'string') throw new Error('文本部件格式错误')
      if (row.text) parts.push({ type: 'text', text: row.text })
    } else if (row.type === 'file') {
      const path = typeof row.path === 'string' ? row.path.trim() : ''
      if (path) parts.push({ type: 'file', path })
    } else {
      throw new Error('提示词部件类型非法')
    }
  }
  return parts
}

/** 频率与有效期配置 */
export function asSchedule(raw: unknown): TaskSchedule {
  if (typeof raw !== 'object' || raw === null) throw new Error('执行频率配置缺失')
  const row = raw as Record<string, unknown>
  const freqGroup = asEnum(row.freqGroup, '频率大类', FREQ_GROUPS, 'cycle')
  const cycleKind = asEnum(row.cycleKind, '周期类型', CYCLE_KINDS, 'daily')
  const intervalKind = asEnum(row.intervalKind, '间隔类型', INTERVAL_KINDS, 'hourly')
  const validityMode = asEnum(row.validityMode, '有效期模式', VALIDITY_MODES, 'forever')

  const schedule: TaskSchedule = {
    freqGroup,
    cycleKind,
    intervalKind,
    onceDate: asOptionalText(row.onceDate, '执行日期', 10) ?? '',
    onceTime: asOptionalText(row.onceTime, '执行时间', 5) ?? '08:00',
    weekDays: normalizeWeekDays(Array.isArray(row.weekDays) ? (row.weekDays as number[]) : []),
    monthDay: asInt(row.monthDay, '每月日期', 1, 1, 31),
    yearMonth: asInt(row.yearMonth, '每年月份', 1, 1, 12),
    yearDay: asInt(row.yearDay, '每年日期', 1, 1, 31),
    weekIntervalDays: normalizeWeekDays(
      Array.isArray(row.weekIntervalDays) ? (row.weekIntervalDays as number[]) : []
    ),
    hourInterval: asInt(row.hourInterval, '间隔小时', 2, 1, 24),
    validityMode,
    validFrom: asOptionalText(row.validFrom, '有效期开始日期', 10) ?? '',
    validFromTime: asOptionalText(row.validFromTime, '有效期开始时间', 5) ?? '00:00',
    validTo: asOptionalText(row.validTo, '有效期结束日期', 10) ?? '',
    validToTime: asOptionalText(row.validToTime, '有效期结束时间', 5) ?? '23:59'
  }

  if (freqGroup === 'cycle' && cycleKind === 'once' && !schedule.onceDate) {
    throw new Error('单次任务需要选择执行日期')
  }
  if (schedule.validityMode === 'range' && (!schedule.validFrom || !schedule.validTo)) {
    throw new Error('指定时间段需要填写开始与结束日期')
  }
  if (freqGroup === 'cycle' && cycleKind === 'weekly' && schedule.weekDays.length === 0) {
    throw new Error('每周任务至少选择一个星期')
  }
  if (
    freqGroup === 'interval' &&
    intervalKind === 'weekly' &&
    schedule.weekIntervalDays.length === 0
  ) {
    throw new Error('每周任务至少选择一个星期')
  }
  if (schedule.validityMode === 'range') {
    const bounds = validityBounds(schedule)
    if (bounds.validFromTs == null || bounds.validToTs == null) {
      throw new Error('有效期时间格式非法')
    }
    if (bounds.validFromTs > bounds.validToTs) throw new Error('有效期开始时间不能晚于结束时间')
  }
  return schedule
}

/** 任务草稿（入参来自渲染层，全部做窄化与上限校验） */
export function asTaskDraft(raw: unknown): NormalizedTaskDraft {
  if (typeof raw !== 'object' || raw === null) throw new Error('任务参数缺失')
  const row = raw as Record<string, unknown>

  const promptParts = asMessageParts(row.promptParts)
  const promptTextRaw = typeof row.promptText === 'string' ? row.promptText.trim() : ''
  if (promptTextRaw.length > MAX_PROMPT_TEXT) throw new Error('提示词长度超出限制')
  const hasFile = promptParts.some((part) => part.type === 'file')
  if (!promptTextRaw && !hasFile) throw new Error('请先填写任务描述或提示词')

  const schedule = asSchedule(row.schedule)
  const title = asOptionalText(row.title, '任务名称', MAX_TITLE) ?? promptTextRaw.slice(0, 18) ?? ''
  const bounds = validityBounds(schedule)

  return {
    title: title || '未命名自动化任务',
    promptText: promptTextRaw,
    promptParts,
    icon: asOptionalText(row.icon, '图标', 8) ?? '⏰',
    source: row.source === 'template' ? 'template' : 'custom',
    templateId: asOptionalText(row.templateId, '模版 id', MAX_LABEL),
    schedule,
    freqSummary: buildFreqSummary(schedule),
    validitySummary: buildValiditySummary(schedule),
    validFromTs: bounds.validFromTs,
    validToTs: bounds.validToTs,
    model: asOptionalText(row.model, '模型', MAX_LABEL),
    customModelId: asOptionalText(row.customModelId, '自定义模型 id', MAX_LABEL),
    expertId: asOptionalText(row.expertId, '专家 id', MAX_LABEL),
    expertName: asOptionalText(row.expertName, '专家名称', MAX_LABEL),
    contextMode: asEnum(row.contextMode, '上下文模式', CONTEXT_MODES, 'default'),
    skillIds: asIdList(row.skillIds, '技能列表', MAX_SKILLS),
    workspaceId: asOptionalText(row.workspaceId, '工作空间 id', MAX_LABEL),
    workspaceName: asOptionalText(row.workspaceName, '工作空间名称', MAX_LABEL),
    fullAccess: asBool(row.fullAccess, false)
  }
}

/** 任务 id */
export function asTaskId(raw: unknown): string {
  return asText(raw, '任务 id', MAX_LABEL)
}

/** 分页条数 */
export function asLimit(raw: unknown, def: number, max: number): number {
  return asInt(raw, '分页条数', def, 1, max)
}
