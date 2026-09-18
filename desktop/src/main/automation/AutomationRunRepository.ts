import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import type {
  AutomationRunRecord,
  AutomationRunStats,
  RunErrorCode,
  RunStatus,
  RunTrigger
} from './types'

/** automation_runs 行结构 */
interface RunRow {
  id: string
  task_id: string
  user_id: string
  trigger: string
  status: string
  scheduled_at: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  conversation_id: string | null
  thread_id: string | null
  output_preview: string | null
  error_code: string | null
  error_message: string | null
  artifacts: string | null
  token_usage: string | null
}

/** 新建运行记录的入参 */
export interface NewRunInput {
  taskId: string
  userId: string
  trigger: RunTrigger
  scheduledAt?: number | null
  startedAt: number
  conversationId?: string | null
  threadId?: string | null
}

/** 结束运行记录的入参 */
export interface FinishRunPatch {
  status: RunStatus
  finishedAt: number
  durationMs: number
  outputPreview?: string | null
  errorCode?: RunErrorCode | null
  errorMessage?: string | null
  artifacts?: unknown[] | null
  tokenUsage?: Record<string, number> | null
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function toRecord(row: RunRow): AutomationRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    conversationId: row.conversation_id,
    threadId: row.thread_id,
    outputPreview: row.output_preview,
    errorCode: (row.error_code as RunErrorCode | null) ?? null,
    errorMessage: row.error_message,
    artifacts: parseJson<unknown[]>(row.artifacts) ?? [],
    tokenUsage: parseJson<Record<string, number>>(row.token_usage)
  }
}

/**
 * 自动化运行记录仓库：写入运行状态、查询历史、统计与清理
 */
export class AutomationRunRepository {
  constructor(private readonly db: Database.Database) {}

  /** 插入一条 running 记录 */
  createRun(input: NewRunInput): AutomationRunRecord {
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO automation_runs (' +
          'id, task_id, user_id, trigger, status, scheduled_at, started_at, conversation_id, thread_id' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        input.taskId,
        input.userId,
        input.trigger,
        'running',
        input.scheduledAt ?? null,
        input.startedAt,
        input.conversationId ?? null,
        input.threadId ?? null
      )
    const row = this.db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as
      RunRow | undefined
    if (!row) throw new Error('运行记录创建失败')
    return toRecord(row)
  }

  /** 结束运行记录 */
  finishRun(id: string, patch: FinishRunPatch): void {
    this.db
      .prepare(
        'UPDATE automation_runs SET status = ?, finished_at = ?, duration_ms = ?, output_preview = ?, ' +
          'error_code = ?, error_message = ?, artifacts = ?, token_usage = ? WHERE id = ?'
      )
      .run(
        patch.status,
        patch.finishedAt,
        patch.durationMs,
        patch.outputPreview ?? null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        patch.artifacts ? JSON.stringify(patch.artifacts) : null,
        patch.tokenUsage ? JSON.stringify(patch.tokenUsage) : null,
        id
      )
  }

  /** 运行记录分页（按 started_at 倒序，cursor 为上一页最后一条的 started_at） */
  listByUser(
    userId: string,
    opts: { taskId?: string | null; limit: number; cursor?: number | null }
  ): AutomationRunRecord[] {
    const params: unknown[] = [userId]
    let sql = 'SELECT * FROM automation_runs WHERE user_id = ?'
    if (opts.taskId) {
      sql += ' AND task_id = ?'
      params.push(opts.taskId)
    }
    if (opts.cursor != null) {
      sql += ' AND started_at < ?'
      params.push(opts.cursor)
    }
    sql += ' ORDER BY started_at DESC LIMIT ?'
    params.push(opts.limit)
    const rows = this.db.prepare(sql).all(...params) as RunRow[]
    return rows.map(toRecord)
  }

  /** 单条运行记录 */
  getById(userId: string, id: string): AutomationRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM automation_runs WHERE user_id = ? AND id = ?')
      .get(userId, id) as RunRow | undefined
    return row ? toRecord(row) : null
  }

  /** 指定时间之后的统计（本周运行次数 / 成功率 / 平均耗时） */
  statsSince(userId: string, sinceTs: number): AutomationRunStats {
    const row = this.db
      .prepare(
        'SELECT ' +
          'COUNT(*) AS total, ' +
          'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS success, ' +
          'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS failed, ' +
          'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS skipped, ' +
          'SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS running, ' +
          'AVG(CASE WHEN finished_at IS NOT NULL THEN duration_ms END) AS avg_duration ' +
          'FROM automation_runs WHERE user_id = ? AND started_at >= ?'
      )
      .get('success', 'failed', 'skipped', 'running', userId, sinceTs) as {
      total: number
      success: number | null
      failed: number | null
      skipped: number | null
      running: number | null
      avg_duration: number | null
    }
    return {
      total: row.total ?? 0,
      success: row.success ?? 0,
      failed: row.failed ?? 0,
      skipped: row.skipped ?? 0,
      running: row.running ?? 0,
      avgDurationMs: row.avg_duration == null ? null : Math.round(row.avg_duration)
    }
  }

  /** 启动时把悬挂的 running 记录标记为 interrupted */
  markRunningAsInterrupted(now: number): number {
    const result = this.db
      .prepare(
        'UPDATE automation_runs SET status = ?, finished_at = ?, error_code = ?, error_message = ? ' +
          'WHERE status = ?'
      )
      .run('interrupted', now, 'interrupted', '应用退出导致中断', 'running')
    return result.changes
  }

  /** 清理策略：每任务保留最近 keepPerTask 条，且删除早于 olderThanTs 的记录 */
  pruneOldRuns(keepPerTask: number, olderThanTs: number): number {
    const result = this.db
      .prepare(
        'DELETE FROM automation_runs WHERE rowid IN (' +
          'SELECT rowid FROM (' +
          'SELECT rowid, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn, ' +
          'started_at FROM automation_runs' +
          ') WHERE rn > ? OR started_at < ?' +
          ')'
      )
      .run(keepPerTask, olderThanTs)
    return result.changes
  }
}
