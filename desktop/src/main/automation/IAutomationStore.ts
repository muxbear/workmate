import type {
  AutomationTaskRecord,
  NormalizedTaskDraft,
  RunStatus,
  TaskStatus
} from './types'

/**
 * 自动化任务存储契约（R8-1 后补抽，2026-10-05）：AutomationRepository 的接口。
 * AutomationService 依赖本接口而非具体类。方法签名与实现逐字一致。
 */
export interface IAutomationStore {
  /** 我的任务列表（未删除，按创建时间倒序） */
  listForUser(userId: string): AutomationTaskRecord[]

  /** 单个任务 */
  getById(userId: string, id: string): AutomationTaskRecord | null

  /** 到期任务（调度使用） */
  listDue(now: number, limit: number): AutomationTaskRecord[]

  /** 新建任务（返回插入后的记录） */
  create(
    userId: string,
    draft: NormalizedTaskDraft,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord

  /** 更新任务定义（保留 id、创建时间与运行计数） */
  update(
    userId: string,
    id: string,
    draft: NormalizedTaskDraft,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord

  /** 最近一次到期时间（调度器用于精确唤醒） */
  earliestNextRunAt(): number | null

  /** 软删除（保留运行历史） */
  softDelete(userId: string, id: string, now: number): number

  /** 暂停 / 继续（继续时由 service 传入重算后的 nextRunAt） */
  setEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord

  /** 只更新排期（运行前后调用） */
  setNextRunAt(id: string, nextRunAt: number | null, status?: TaskStatus, now?: number): void

  /** 运行计数与最近状态（成功失败都记） */
  bumpRunCounters(id: string, ok: boolean, status: RunStatus, at: number): void
}
