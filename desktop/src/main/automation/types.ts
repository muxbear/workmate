import type { MessagePart } from '../../preload/index.d'

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

/** 上下文模式（与渲染层 catalog.mode 对齐） */
export type ContextMode = 'default' | 'local' | 'knowledge'

/** 失败分类（见方案 9.2） */
export type RunErrorCode =
  | 'model_not_configured'
  | 'workspace_unavailable'
  | 'file_missing'
  | 'timeout'
  | 'agent_error'
  | 'interrupted'

/** 频率与有效期配置（与前端 AutomationPage 的 TaskSchedule 完全一致） */
export interface TaskSchedule {
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

/** 校验后的任务草稿（service 内部使用） */
export interface NormalizedTaskDraft {
  title: string
  promptText: string
  promptParts: MessagePart[]
  icon: string
  source: 'custom' | 'template'
  templateId: string | null
  schedule: TaskSchedule
  freqSummary: string
  validitySummary: string
  validFromTs: number | null
  validToTs: number | null
  model: string | null
  customModelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: ContextMode
  skillIds: string[]
  workspaceId: string | null
  workspaceName: string | null
  fullAccess: boolean
}

/** 任务记录（DB 行映射后的领域对象） */
export interface AutomationTaskRecord extends NormalizedTaskDraft {
  id: string
  userId: string
  enabled: boolean
  status: TaskStatus
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: RunStatus | null
  runCount: number
  failCount: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 运行记录 */
export interface AutomationRunRecord {
  id: string
  taskId: string
  userId: string
  trigger: RunTrigger
  status: RunStatus
  scheduledAt: number | null
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  conversationId: string | null
  threadId: string | null
  outputPreview: string | null
  errorCode: RunErrorCode | null
  errorMessage: string | null
  artifacts: unknown[] | null
  tokenUsage: Record<string, number> | null
}

/** 统计口径：本周运行次数 / 成功率 / 平均耗时 */
export interface AutomationRunStats {
  total: number
  success: number
  failed: number
  skipped: number
  running: number
  avgDurationMs: number | null
}

/** 排期计算结果 */
export interface ComputeNextRunResult {
  nextRunAt: number | null
  terminal?: 'expired' | 'finished'
}
