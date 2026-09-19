/**
 * 定时任务（自动化）领域类型
 *
 * 字段语义与后端 api/automation/schemas.py 一致（camelCase 由后端别名序列化），
 * 并与桌面版「自动化」菜单的数据结构保持对齐。
 */

/** 频率大类：周期 / 间隔 */
export type FreqGroup = 'cycle' | 'interval'

/** 周期类型：单次 / 每天 / 每周 / 每月 / 每年 */
export type CycleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'

/** 间隔类型：每周（选星期）/ 每隔 N 小时 */
export type IntervalKind = 'weekly' | 'hourly'

/** 有效期模式：长期有效 / 指定时间段 */
export type ValidityMode = 'forever' | 'range'

/** 任务状态 */
export type TaskStatus = 'enabled' | 'paused' | 'expired' | 'finished'

/** 运行状态 */
export type RunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'canceled' | 'interrupted'

/** 触发来源 */
export type RunTrigger = 'schedule' | 'manual' | 'catchup' | 'retry'

/** 上下文模式（对齐对话输入卡：默认 / 引用上传文件 / 引用知识库） */
export type ContextMode = 'default' | 'files' | 'knowledge'

/** 失败分类 */
export type RunErrorCode =
  | 'model_not_configured'
  | 'workspace_unavailable'
  | 'file_missing'
  | 'timeout'
  | 'agent_error'
  | 'interrupted'

/** 频率与有效期配置 */
export interface AutomationSchedule {
  freqGroup: FreqGroup
  cycleKind: CycleKind
  intervalKind: IntervalKind
  onceDate: string
  onceTime: string
  weekDays: number[]
  monthDay: number
  yearMonth: number
  yearDay: number
  weekIntervalDays: number[]
  hourInterval: number
  validityMode: ValidityMode
  validFrom: string
  validFromTime: string
  validTo: string
  validToTime: string
}

/** 提示词部件（文本段 / 文件段，与后端 PromptPart 对应） */
export interface AutomationPromptPart {
  type: 'text' | 'file'
  text?: string | null
  attachmentId?: string | null
  filename?: string | null
}

/** 任务实体（后端 AutomationTaskResponse） */
export interface AutomationTask {
  id: string
  title: string
  promptText: string
  promptParts: AutomationPromptPart[]
  icon: string
  source: 'custom' | 'template'
  templateId: string | null
  schedule: AutomationSchedule
  freqSummary: string
  validitySummary: string
  validFromTs: number | null
  validToTs: number | null
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
  enabled: boolean
  status: TaskStatus
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: RunStatus | null
  runCount: number
  failCount: number
  createdAt: number
  updatedAt: number
}

/** 新建 / 更新任务的请求体（后端 AutomationTaskDraft） */
export interface AutomationTaskDraft {
  title: string
  promptText: string
  promptParts: AutomationPromptPart[]
  icon: string
  source: 'custom' | 'template'
  templateId: string | null
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

/** 运行记录（后端 AutomationRunResponse） */
export interface AutomationRun {
  id: string
  taskId: string
  trigger: RunTrigger
  status: RunStatus
  scheduledAt: number | null
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  conversationId: string | null
  threadId: string | null
  outputPreview: string | null
  outputText: string | null
  model: string | null
  errorCode: RunErrorCode | null
  errorMessage: string | null
  artifacts: Record<string, unknown>[]
  tokenUsage: Record<string, unknown> | null
}

/** 运行统计（本周运行次数 / 成功率 / 平均耗时） */
export interface AutomationRunStats {
  total: number
  success: number
  failed: number
  skipped: number
  running: number
  avgDurationMs: number | null
}

/** 任务状态元信息 */
export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; color: string; dot: string; bg: string }
> = {
  enabled: { label: '运行中', color: '#6ee7b7', dot: '#10B981', bg: 'rgba(16,185,129,0.12)' },
  paused: { label: '已暂停', color: '#fbbf24', dot: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  expired: { label: '已过期', color: '#94a3b8', dot: '#94A3B8', bg: 'rgba(148,163,184,0.12)' },
  finished: { label: '已完成', color: '#a5b4fc', dot: '#818CF8', bg: 'rgba(99,102,241,0.12)' },
}

/** 运行状态元信息 */
export const RUN_STATUS_META: Record<RunStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: '#22d3ee' },
  success: { label: '成功', color: '#6ee7b7' },
  failed: { label: '失败', color: '#f87171' },
  skipped: { label: '跳过', color: '#fbbf24' },
  canceled: { label: '已取消', color: '#94a3b8' },
  interrupted: { label: '已中断', color: '#fb923c' },
}

/** 触发来源文案 */
export const RUN_TRIGGER_LABEL: Record<RunTrigger, string> = {
  schedule: '定时触发',
  manual: '手动运行',
  catchup: '错过后补跑',
  retry: '重试',
}

/** 上下文模式文案 */
export const CONTEXT_MODE_LABEL: Record<ContextMode, string> = {
  default: '默认',
  files: '引用上传文件',
  knowledge: '引用知识库',
}

/** 周一至周日（value 1 至 7，7 为周日） */
export const WEEK_DAYS: { value: number; label: string }[] = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' },
]

/** 星期多选文案（按周一至周日排序，如「一、三」） */
export function weekDaysText(days: number[]): string {
  return [...days]
    .sort((a, b) => a - b)
    .map((value) => WEEK_DAYS.find((day) => day.value === value)?.label ?? '')
    .filter((label) => label.length > 0)
    .join('、')
}

/** 周期选项：单次 / 每天 / 每周 / 每月 / 每年 */
export const CYCLE_OPTIONS: { key: CycleKind; label: string }[] = [
  { key: 'once', label: '单次' },
  { key: 'daily', label: '每天' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
]

/** 间隔选项：每周（选星期）/ 每隔（N 小时执行 1 次） */
export const INTERVAL_OPTIONS: { key: IntervalKind; label: string }[] = [
  { key: 'weekly', label: '每周' },
  { key: 'hourly', label: '每隔' },
]

/** 本地日期（YYYY-MM-DD），offsetDays 为相对今天的天数 */
export function localDate(offsetDays = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

/** 默认频率与有效期配置（新建任务弹窗初始值） */
export function createDefaultSchedule(): AutomationSchedule {
  return {
    freqGroup: 'cycle',
    cycleKind: 'daily',
    intervalKind: 'hourly',
    onceDate: localDate(),
    onceTime: '08:00',
    weekDays: [1],
    monthDay: 1,
    yearMonth: 1,
    yearDay: 1,
    weekIntervalDays: [1],
    hourInterval: 2,
    validityMode: 'forever',
    validFrom: localDate(),
    validFromTime: '00:00',
    validTo: localDate(30),
    validToTime: '23:59',
  }
}

/** 执行频率摘要文案（列表卡片展示，与后端 build_freq_summary 一致） */
export function buildFreqSummary(schedule: AutomationSchedule): string {
  if (schedule.freqGroup === 'cycle') {
    if (schedule.cycleKind === 'once') return '单次 ' + schedule.onceDate + ' ' + schedule.onceTime
    if (schedule.cycleKind === 'daily') return '每天 ' + schedule.onceTime
    if (schedule.cycleKind === 'weekly')
      return '每周' + weekDaysText(schedule.weekDays) + ' ' + schedule.onceTime
    if (schedule.cycleKind === 'monthly')
      return '每月 ' + schedule.monthDay + ' 日 ' + schedule.onceTime
    return '每年 ' + schedule.yearMonth + ' 月 ' + schedule.yearDay + ' 日 ' + schedule.onceTime
  }
  if (schedule.intervalKind === 'weekly')
    return '每周' + weekDaysText(schedule.weekIntervalDays) + ' 执行'
  return '每隔 ' + schedule.hourInterval + ' 小时执行 1 次'
}

/** 有效期摘要文案 */
export function buildValiditySummary(schedule: AutomationSchedule): string {
  if (schedule.freqGroup === 'cycle' && schedule.cycleKind === 'once') return '单次执行'
  if (schedule.validityMode === 'forever') return '长期有效'
  return (
    schedule.validFrom +
    ' ' +
    schedule.validFromTime +
    ' 至 ' +
    schedule.validTo +
    ' ' +
    schedule.validToTime
  )
}

/** 自动化任务模版（与桌面版 AutomationPage 的 automationTemplates 一致） */
export interface AutomationTemplate {
  id: number
  icon: string
  title: string
  desc: string
  freq: string
  schedule: AutomationSchedule
}

/** 模版排期：在默认值基础上覆盖差异字段 */
function templateSchedule(patch: Partial<AutomationSchedule>): AutomationSchedule {
  return { ...createDefaultSchedule(), ...patch }
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 1,
    icon: '📰',
    title: '每日 AI 新闻推送',
    desc: '关注当天 AI 领域的重要动态，侧重产品与技术突破',
    freq: '每天 08:00',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '08:00' }),
  },
  {
    id: 2,
    icon: '🔤',
    title: '每日 5 个英语单词',
    desc: '每天推荐 5 个高频实用英语单词，配例句与记忆技巧',
    freq: '每天 07:30',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '07:30' }),
  },
  {
    id: 3,
    icon: '🌙',
    title: '每日儿童睡前故事',
    desc: '生成 3-5 分钟可读的温和睡前故事，适合亲子共读',
    freq: '每天 20:30',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '20:30' }),
  },
  {
    id: 4,
    icon: '📋',
    title: '每周工作周报',
    desc: '每周五汇总仓库 PR 与 Issue 进展，自动生成周报草稿',
    freq: '每周五 18:00',
    schedule: templateSchedule({ cycleKind: 'weekly', weekDays: [5], onceTime: '18:00' }),
  },
  {
    id: 5,
    icon: '🎬',
    title: '经典电影推荐',
    desc: '推荐一部高分经典电影，简要介绍背景与观影理由',
    freq: '每周三 12:00',
    schedule: templateSchedule({ cycleKind: 'weekly', weekDays: [3], onceTime: '12:00' }),
  },
  {
    id: 6,
    icon: '📅',
    title: '历史上的今天',
    desc: '从科技、电影、音乐等领域挑选一件有趣的历史事件',
    freq: '每天 09:00',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '09:00' }),
  },
  {
    id: 7,
    icon: '💡',
    title: '每日一个为什么',
    desc: '每天提出一个有趣问题，先提问再揭晓答案，启发思考',
    freq: '每天 10:00',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '10:00' }),
  },
  {
    id: 8,
    icon: '📞',
    title: '父母联系提醒',
    desc: '每周日 10:00 提醒你给家人打电话，珍惜家人时光',
    freq: '每周日 10:00',
    schedule: templateSchedule({ cycleKind: 'weekly', weekDays: [7], onceTime: '10:00' }),
  },
  {
    id: 9,
    icon: '🏥',
    title: '体检预约提醒',
    desc: '在指定时间提醒你确认体检预约，提前做好准备',
    freq: '单次 07:00',
    schedule: templateSchedule({ cycleKind: 'once', onceTime: '07:00' }),
  },
  {
    id: 10,
    icon: '💼',
    title: '面试准备提醒',
    desc: '工作日每 2 小时提醒你复习大模型相关知识点',
    freq: '工作日 每2h',
    schedule: templateSchedule({ freqGroup: 'interval', intervalKind: 'hourly', hourInterval: 2 }),
  },
  {
    id: 11,
    icon: '📝',
    title: '会议前准备',
    desc: '在会议开始前提醒你整理议题，目标与所需材料',
    freq: '会前 15min',
    schedule: templateSchedule({ freqGroup: 'interval', intervalKind: 'hourly', hourInterval: 1 }),
  },
  {
    id: 12,
    icon: '🐱',
    title: '可爱萌宠手机壁纸',
    desc: '随机从 7 种风格中挑选一种，生成今日专属萌宠壁纸',
    freq: '每天 07:00',
    schedule: templateSchedule({ cycleKind: 'daily', onceTime: '07:00' }),
  },
]
