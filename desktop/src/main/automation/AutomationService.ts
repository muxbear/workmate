import type { AutomationRepository } from './AutomationRepository'
import type { AutomationRunRepository } from './AutomationRunRepository'
import type {
  AutomationRunRecord,
  AutomationRunStats,
  AutomationTaskRecord,
  RunTrigger,
  TaskStatus
} from './types'
import { asBool, asLimit, asTaskDraft, asTaskId } from './validation'
import type { AuditLogRepository } from './AuditLogRepository'
import { computeNextRun } from './AutomationSchedule'

/** 排期结果：下次触发时间与任务状态 */
export interface TaskScheduleResult {
  nextRunAt: number | null
  status: TaskStatus
}

/** 执行器注入点（M2 接入 AutomationRunner 后使用） */
export interface AutomationServiceDeps {
  /** 审计日志（可选，未注入时跳过） */
  audit?: AuditLogRepository

  enqueueRun?: (task: AutomationTaskRecord, trigger: RunTrigger) => Promise<{ runId: string }>
}

/** 运行记录默认保留策略 */
const KEEP_RUNS_PER_TASK = 200
const RUNS_RETENTION_MS = 90 * 24 * 3600 * 1000

/**
 * 自动化业务服务：入参校验、CRUD 编排、排期计算、运行记录查询
 *
 * 说明：所有方法都要求 userId（来自 session.requireUserId），
 * 仓库层再带一次 user_id 条件，双重保证用户隔离。
 */
export class AutomationService {
  constructor(
    private readonly tasks: AutomationRepository,
    private readonly runs: AutomationRunRepository,
    private readonly deps: AutomationServiceDeps = {}
  ) {}

  /** 我的任务列表 */
  listTasks(userId: string): AutomationTaskRecord[] {
    return this.tasks.listForUser(userId)
  }

  /** 单个任务（编辑弹窗回填） */
  getTask(userId: string, rawId: unknown): AutomationTaskRecord {
    const id = asTaskId(rawId)
    const task = this.tasks.getById(userId, id)
    if (!task) throw new Error('任务不存在或已被删除')
    return task
  }

  /** 新建任务：校验 → 计算排期 → 落库 */
  createTask(userId: string, rawDraft: unknown): AutomationTaskRecord {
    const draft = asTaskDraft(rawDraft)
    const now = Date.now()
    const schedule = this.resolveSchedule(draft.schedule, now, {
      validToTs: draft.validToTs,
      lastRunAt: null,
      executedOnce: false
    })
    const created = this.tasks.create(userId, draft, {
      nextRunAt: schedule.nextRunAt,
      status: schedule.status,
      now
    })
    this.deps.audit?.record(userId, 'automation.create', {
      taskId: created.id,
      source: created.source,
      freq: created.freqSummary,
      fullAccess: created.fullAccess
    })
    return created
  }

  /** 更新任务：重算排期，进行中的运行不受影响 */
  updateTask(userId: string, rawId: unknown, rawDraft: unknown): AutomationTaskRecord {
    const id = asTaskId(rawId)
    const current = this.tasks.getById(userId, id)
    if (!current) throw new Error('任务不存在或已被删除')

    const draft = asTaskDraft(rawDraft)
    const now = Date.now()
    const executedOnce = current.runCount > 0
    const schedule = this.resolveSchedule(draft.schedule, now, {
      validToTs: draft.validToTs,
      lastRunAt: current.lastRunAt,
      executedOnce
    })
    const status: TaskStatus = current.enabled ? schedule.status : 'paused'
    const updated = this.tasks.update(userId, id, draft, {
      nextRunAt: current.enabled ? schedule.nextRunAt : null,
      status,
      now
    })
    this.deps.audit?.record(userId, 'automation.update', {
      taskId: id,
      freq: updated.freqSummary,
      fullAccess: updated.fullAccess
    })
    return updated
  }

  /** 删除任务（软删除，保留运行历史） */
  deleteTask(userId: string, rawId: unknown): number {
    const id = asTaskId(rawId)
    const changes = this.tasks.softDelete(userId, id, Date.now())
    if (changes === 0) throw new Error('任务不存在或已被删除')
    this.deps.audit?.record(userId, 'automation.delete', { taskId: id })
    return changes
  }

  /** 暂停 / 继续：继续时重算下一次触发时间 */
  setEnabled(userId: string, rawId: unknown, rawEnabled: unknown): AutomationTaskRecord {
    const id = asTaskId(rawId)
    const enabled = asBool(rawEnabled, true)
    const task = this.tasks.getById(userId, id)
    if (!task) throw new Error('任务不存在或已被删除')
    const now = Date.now()
    if (!enabled) {
      const paused = this.tasks.setEnabled(userId, id, false, {
        nextRunAt: null,
        status: 'paused',
        now
      })
      this.deps.audit?.record(userId, 'automation.enable', { taskId: id, enabled: false })
      return paused
    }
    const schedule = this.resolveSchedule(task.schedule, now, {
      validToTs: task.validToTs,
      lastRunAt: task.lastRunAt,
      executedOnce: task.runCount > 0
    })
    const resumed = this.tasks.setEnabled(userId, id, true, {
      nextRunAt: schedule.nextRunAt,
      status: schedule.status,
      now
    })
    this.deps.audit?.record(userId, 'automation.enable', {
      taskId: id,
      enabled: true,
      fullAccess: resumed.fullAccess
    })
    return resumed
  }

  /** 立即运行（入队交给执行器） */
  async runNow(userId: string, rawId: unknown): Promise<{ runId: string }> {
    const task = this.getTask(userId, rawId)
    if (!this.deps.enqueueRun) throw new Error('自动化执行器尚未接入')
    this.deps.audit?.record(userId, 'automation.run', { taskId: task.id, trigger: 'manual' })
    return this.deps.enqueueRun(task, 'manual')
  }

  /** 单条运行记录（运行结果详情用） */
  getRun(userId: string, rawId: unknown): AutomationRunRecord {
    const id = asTaskId(rawId)
    const run = this.runs.getById(userId, id)
    if (!run) throw new Error('运行记录不存在')
    return run
  }

  /** 运行记录分页 */
  listRuns(
    userId: string,
    rawOpts?: { taskId?: unknown; limit?: unknown; cursor?: unknown }
  ): AutomationRunRecord[] {
    const taskId = rawOpts && rawOpts.taskId ? asTaskId(rawOpts.taskId) : null
    const limit = asLimit(rawOpts ? rawOpts.limit : undefined, 50, 200)
    const cursorRaw = rawOpts ? rawOpts.cursor : undefined
    const cursor = typeof cursorRaw === 'number' && Number.isFinite(cursorRaw) ? cursorRaw : null
    return this.runs.listByUser(userId, { taskId, limit, cursor })
  }

  /** 统计：默认统计本周（从周一 00:00 起） */
  runStats(userId: string, rawSince?: unknown): AutomationRunStats {
    const since =
      typeof rawSince === 'number' && Number.isFinite(rawSince) ? rawSince : this.weekStartTs()
    return this.runs.statsSince(userId, since)
  }

  /** 调度器使用：计算并写回 next_run_at（运行前推后、运行后重排都走这里） */
  scheduleTask(
    task: AutomationTaskRecord,
    from: number,
    opts?: { persist?: boolean }
  ): TaskScheduleResult {
    const executedOnce = task.runCount > 0
    const result = this.resolveSchedule(task.schedule, from, {
      validToTs: task.validToTs,
      lastRunAt: task.lastRunAt,
      executedOnce
    })
    const nextRunAt = task.enabled ? result.nextRunAt : null
    const status: TaskStatus = task.enabled ? result.status : 'paused'
    if (opts?.persist !== false && (task.nextRunAt !== nextRunAt || task.status !== status)) {
      this.tasks.setNextRunAt(task.id, nextRunAt, status, from)
    }
    return { nextRunAt, status }
  }

  /** 注入执行器（主进程装配时调用，避免与 Runner 的构造循环依赖） */
  setRunHandler(
    handler: (task: AutomationTaskRecord, trigger: RunTrigger) => Promise<{ runId: string }>
  ): void {
    this.deps.enqueueRun = handler
  }

  /** 调度器使用：查询到期任务 */
  listDueTasks(now: number, limit: number): AutomationTaskRecord[] {
    return this.tasks.listDue(now, limit)
  }

  /** 按 id 取任务（不存在返回 null，不抛错） */
  findTask(userId: string, id: string): AutomationTaskRecord | null {
    return this.tasks.getById(userId, id)
  }

  /** 最近一次到期时间，调度器用于精确唤醒 */
  earliestNextRunAt(): number | null {
    return this.tasks.earliestNextRunAt()
  }

  /** 悬挂运行标记为中断（退出 / 启动时调用） */
  markRunningInterrupted(now: number = Date.now()): number {
    return this.runs.markRunningAsInterrupted(now)
  }

  /** 记录一次跳过（应用未运行、上次未结束等）并重排下一次触发 */
  recordSkipped(task: AutomationTaskRecord, trigger: RunTrigger, reason: string, at: number): void {
    const run = this.runs.createRun({
      taskId: task.id,
      userId: task.userId,
      trigger,
      scheduledAt: task.nextRunAt,
      startedAt: at
    })
    this.runs.finishRun(run.id, {
      status: 'skipped',
      finishedAt: at,
      durationMs: 0,
      errorMessage: reason
    })
    this.tasks.bumpRunCounters(task.id, false, 'skipped', at)
    const fresh = this.tasks.getById(task.userId, task.id)
    if (fresh) this.scheduleTask(fresh, at)
  }
  /** 应用启动清理：悬挂运行标记为中断 + 清理过期运行记录 */
  onStartup(now: number = Date.now()): { interrupted: number; pruned: number } {
    const interrupted = this.runs.markRunningAsInterrupted(now)
    const pruned = this.runs.pruneOldRuns(KEEP_RUNS_PER_TASK, now - RUNS_RETENTION_MS)
    return { interrupted, pruned }
  }

  /** 排期计算：统一把 terminal 状态映射为任务状态 */
  private resolveSchedule(
    schedule: AutomationTaskRecord['schedule'],
    from: number,
    opts: { validToTs: number | null; lastRunAt: number | null; executedOnce: boolean }
  ): TaskScheduleResult {
    const result = computeNextRun(schedule, {
      from,
      validToTs: opts.validToTs,
      lastRunAt: opts.lastRunAt,
      executedOnce: opts.executedOnce
    })
    if (result.terminal === 'expired') return { nextRunAt: null, status: 'expired' }
    if (result.terminal === 'finished') return { nextRunAt: null, status: 'finished' }
    return { nextRunAt: result.nextRunAt, status: 'enabled' }
  }

  /** 本周一 00:00 的毫秒时间戳（统计口径） */
  private weekStartTs(now: number = Date.now()): number {
    const date = new Date(now)
    const weekday = (date.getDay() + 6) % 7
    const start = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - weekday,
      0,
      0,
      0,
      0
    )
    return start.getTime()
  }
}
