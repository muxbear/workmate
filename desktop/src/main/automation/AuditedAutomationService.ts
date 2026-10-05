import type { AutomationRunRecord, AutomationRunStats, AutomationTaskRecord, RunTrigger } from './types'
import type { IAutomationService, TaskScheduleResult } from './AutomationService'
import type { AuditLogRepository } from './AuditLogRepository'
import { asBool, asTaskId } from './validation'

/**
 * 审计装饰器（R8-10）：把审计日志从 AutomationService 剥离为横切层。
 *
 * - **audit 必填**（构造即注入）：漏接审计不再是「静默跳过」；
 * - 仅 6 个变更入口记录（create / update / delete / enable×2 / run），查询与调度方法直接透传；
 * - 载荷与原实现逐字一致；记录时机在业务调用成功之后（原实现即如此——抛错路径不记录）。
 * - **唯一的时机微差（如实记录）**：runNow 原实现把记录放在「执行器已接线」检查之后，
 *   装饰器无法从外部感知接线状态，改为先记录再委托——仅在误配置（未 setRunHandler）
 *   且用户触发的组合下多出一条 audit，生产装配（index.ts 必接执行器）下两者等价。
 */
export class AuditedAutomationService implements IAutomationService {
  constructor(
    private readonly inner: IAutomationService,
    private readonly audit: AuditLogRepository
  ) {}

  // ── 透传（查询 / 调度 / 生命周期）──

  listTasks(userId: string): AutomationTaskRecord[] {
    return this.inner.listTasks(userId)
  }

  getTask(userId: string, rawId: unknown): AutomationTaskRecord {
    return this.inner.getTask(userId, rawId)
  }

  getRun(userId: string, rawId: unknown): AutomationRunRecord {
    return this.inner.getRun(userId, rawId)
  }

  listRuns(
    userId: string,
    rawOpts?: { taskId?: unknown; limit?: unknown; cursor?: unknown }
  ): AutomationRunRecord[] {
    return this.inner.listRuns(userId, rawOpts)
  }

  runStats(userId: string, rawSince?: unknown): AutomationRunStats {
    return this.inner.runStats(userId, rawSince)
  }

  scheduleTask(
    task: AutomationTaskRecord,
    from: number,
    opts?: { persist?: boolean }
  ): TaskScheduleResult {
    return this.inner.scheduleTask(task, from, opts)
  }

  setRunHandler(
    handler: (task: AutomationTaskRecord, trigger: RunTrigger) => Promise<{ runId: string }>
  ): void {
    this.inner.setRunHandler(handler)
  }

  listDueTasks(now: number, limit: number): AutomationTaskRecord[] {
    return this.inner.listDueTasks(now, limit)
  }

  findTask(userId: string, id: string): AutomationTaskRecord | null {
    return this.inner.findTask(userId, id)
  }

  earliestNextRunAt(): number | null {
    return this.inner.earliestNextRunAt()
  }

  markRunningInterrupted(now?: number): number {
    return this.inner.markRunningInterrupted(now)
  }

  recordSkipped(task: AutomationTaskRecord, trigger: RunTrigger, reason: string, at: number): void {
    this.inner.recordSkipped(task, trigger, reason, at)
  }

  onStartup(now?: number): { interrupted: number; pruned: number } {
    return this.inner.onStartup(now)
  }

  // ── 审计入口（6 处；载荷与原实现逐字一致）──

  createTask(userId: string, rawDraft: unknown): AutomationTaskRecord {
    const created = this.inner.createTask(userId, rawDraft)
    this.audit.record(userId, 'automation.create', {
      taskId: created.id,
      source: created.source,
      freq: created.freqSummary,
      fullAccess: created.fullAccess
    })
    return created
  }

  updateTask(userId: string, rawId: unknown, rawDraft: unknown): AutomationTaskRecord {
    const updated = this.inner.updateTask(userId, rawId, rawDraft)
    this.audit.record(userId, 'automation.update', {
      taskId: updated.id,
      freq: updated.freqSummary,
      fullAccess: updated.fullAccess
    })
    return updated
  }

  deleteTask(userId: string, rawId: unknown): number {
    const changes = this.inner.deleteTask(userId, rawId)
    // 原实现仅在成功删除（未抛错）时记录；此处等价
    this.audit.record(userId, 'automation.delete', { taskId: asTaskId(rawId) })
    return changes
  }

  setEnabled(userId: string, rawId: unknown, rawEnabled: unknown): AutomationTaskRecord {
    const enabled = asBool(rawEnabled, true)
    const task = this.inner.setEnabled(userId, rawId, rawEnabled)
    if (!enabled) {
      this.audit.record(userId, 'automation.enable', { taskId: task.id, enabled: false })
    } else {
      this.audit.record(userId, 'automation.enable', {
        taskId: task.id,
        enabled: true,
        fullAccess: task.fullAccess
      })
    }
    return task
  }

  async runNow(userId: string, rawId: unknown): Promise<{ runId: string }> {
    const task = this.inner.getTask(userId, rawId)
    this.audit.record(userId, 'automation.run', { taskId: task.id, trigger: 'manual' })
    return this.inner.runNow(userId, rawId)
  }
}
