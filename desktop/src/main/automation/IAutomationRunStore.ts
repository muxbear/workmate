import type { AutomationRunRecord, AutomationRunStats } from './types'
import type { FinishRunPatch, NewRunInput } from './AutomationRunRepository'

/**
 * 自动化运行记录存储契约（R8-1 后补抽，2026-10-05）：AutomationRunRepository 的接口。
 * AutomationService / AutomationRunner 依赖本接口而非具体类。方法签名与实现逐字一致。
 */
export interface IAutomationRunStore {
  /** 插入一条 running 记录 */
  createRun(input: NewRunInput): AutomationRunRecord

  /** 结束运行记录 */
  finishRun(id: string, patch: FinishRunPatch): void

  /** 运行记录分页（按 started_at 倒序，cursor 为上一页最后一条的 started_at） */
  listByUser(
    userId: string,
    opts: { taskId?: string | null; limit: number; cursor?: number | null }
  ): AutomationRunRecord[]

  /** 单条运行记录 */
  getById(userId: string, id: string): AutomationRunRecord | null

  /** 指定时间之后的统计（本周运行次数 / 成功率 / 平均耗时） */
  statsSince(userId: string, sinceTs: number): AutomationRunStats

  /** 启动时把悬挂的 running 记录标记为 interrupted */
  markRunningAsInterrupted(now: number): number

  /** 清理策略：每任务保留最近 keepPerTask 条，且删除早于 olderThanTs 的记录 */
  pruneOldRuns(keepPerTask: number, olderThanTs: number): number
}
