import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import type {
  AutomationTaskRecord,
  NormalizedTaskDraft,
  RunStatus,
  TaskSchedule,
  TaskStatus
} from './types'
import type { MessagePart } from '../../preload/index.d'

/** automation_tasks 行结构（snake_case 与库表一致） */
interface TaskRow {
  id: string
  user_id: string
  title: string
  prompt_text: string
  prompt_parts: string
  icon: string | null
  source: string
  template_id: string | null
  schedule: string
  freq_summary: string | null
  validity_summary: string | null
  valid_from_ts: number | null
  valid_to_ts: number | null
  model: string | null
  custom_model_id: string | null
  expert_id: string | null
  expert_name: string | null
  context_mode: string
  skill_ids: string
  workspace_id: string | null
  workspace_name: string | null
  full_access: number
  enabled: number
  status: string
  next_run_at: number | null
  last_run_at: number | null
  last_run_status: string | null
  run_count: number
  fail_count: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** JSON 列安全解析（损坏时回退默认值，不影响列表加载） */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** DB 行映射为领域对象 */
function toRecord(row: TaskRow): AutomationTaskRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    promptText: row.prompt_text,
    promptParts: parseJson<MessagePart[]>(row.prompt_parts, []),
    icon: row.icon ?? '⏰',
    source: row.source === 'template' ? 'template' : 'custom',
    templateId: row.template_id,
    schedule: parseJson<TaskSchedule>(row.schedule, {} as TaskSchedule),
    freqSummary: row.freq_summary ?? '',
    validitySummary: row.validity_summary ?? '',
    validFromTs: row.valid_from_ts,
    validToTs: row.valid_to_ts,
    model: row.model,
    customModelId: row.custom_model_id,
    expertId: row.expert_id,
    expertName: row.expert_name,
    contextMode:
      row.context_mode === 'local' || row.context_mode === 'knowledge'
        ? row.context_mode
        : 'default',
    skillIds: parseJson<string[]>(row.skill_ids, []),
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    fullAccess: row.full_access === 1,
    enabled: row.enabled === 1,
    status: row.status as TaskStatus,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: (row.last_run_status as RunStatus | null) ?? null,
    runCount: row.run_count,
    failCount: row.fail_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  }
}

/**
 * 自动化任务仓库：全部方法按 userId 作用域，跨用户读写会被 SQL 条件拦住
 */
export class AutomationRepository {
  constructor(private readonly db: Database.Database) {}

  /** 我的任务列表（未删除，按创建时间倒序） */
  listForUser(userId: string): AutomationTaskRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM automation_tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
      )
      .all(userId) as TaskRow[]
    return rows.map(toRecord)
  }

  /** 单个任务 */
  getById(userId: string, id: string): AutomationTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM automation_tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
      .get(userId, id) as TaskRow | undefined
    return row ? toRecord(row) : null
  }

  /** 到期任务（调度使用） */
  listDue(now: number, limit: number): AutomationTaskRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM automation_tasks WHERE deleted_at IS NULL AND enabled = 1 AND status = ? ' +
          'AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?'
      )
      .all('enabled', now, limit) as TaskRow[]
    return rows.map(toRecord)
  }

  /** 新建任务（返回插入后的记录） */
  create(
    userId: string,
    draft: NormalizedTaskDraft,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord {
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO automation_tasks (' +
          'id, user_id, title, prompt_text, prompt_parts, icon, source, template_id, schedule, ' +
          'freq_summary, validity_summary, valid_from_ts, valid_to_ts, model, custom_model_id, ' +
          'expert_id, expert_name, context_mode, skill_ids, workspace_id, workspace_name, full_access, ' +
          'enabled, status, next_run_at, run_count, fail_count, created_at, updated_at' +
          ') VALUES (' +
          '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?' +
          ')'
      )
      .run(
        id,
        userId,
        draft.title,
        draft.promptText,
        JSON.stringify(draft.promptParts),
        draft.icon,
        draft.source,
        draft.templateId,
        JSON.stringify(draft.schedule),
        draft.freqSummary,
        draft.validitySummary,
        draft.validFromTs,
        draft.validToTs,
        draft.model,
        draft.customModelId,
        draft.expertId,
        draft.expertName,
        draft.contextMode,
        JSON.stringify(draft.skillIds),
        draft.workspaceId,
        draft.workspaceName,
        draft.fullAccess ? 1 : 0,
        opts.status === 'paused' ? 0 : 1,
        opts.status,
        opts.nextRunAt,
        opts.now,
        opts.now
      )
    const created = this.getById(userId, id)
    if (!created) throw new Error('任务创建失败')
    return created
  }

  /** 更新任务定义（保留 id、创建时间与运行计数） */
  update(
    userId: string,
    id: string,
    draft: NormalizedTaskDraft,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord {
    const result = this.db
      .prepare(
        'UPDATE automation_tasks SET ' +
          'title = ?, prompt_text = ?, prompt_parts = ?, icon = ?, source = ?, template_id = ?, ' +
          'schedule = ?, freq_summary = ?, validity_summary = ?, valid_from_ts = ?, valid_to_ts = ?, ' +
          'model = ?, custom_model_id = ?, expert_id = ?, expert_name = ?, context_mode = ?, ' +
          'skill_ids = ?, workspace_id = ?, workspace_name = ?, full_access = ?, status = ?, ' +
          'next_run_at = ?, updated_at = ? ' +
          'WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      )
      .run(
        draft.title,
        draft.promptText,
        JSON.stringify(draft.promptParts),
        draft.icon,
        draft.source,
        draft.templateId,
        JSON.stringify(draft.schedule),
        draft.freqSummary,
        draft.validitySummary,
        draft.validFromTs,
        draft.validToTs,
        draft.model,
        draft.customModelId,
        draft.expertId,
        draft.expertName,
        draft.contextMode,
        JSON.stringify(draft.skillIds),
        draft.workspaceId,
        draft.workspaceName,
        draft.fullAccess ? 1 : 0,
        opts.status,
        opts.nextRunAt,
        opts.now,
        userId,
        id
      )
    if (result.changes === 0) throw new Error('任务不存在或已被删除')
    const updated = this.getById(userId, id)
    if (!updated) throw new Error('任务更新失败')
    return updated
  }

  /** 最近一次到期时间（调度器用于精确唤醒） */
  earliestNextRunAt(): number | null {
    const row = this.db
      .prepare(
        'SELECT MIN(next_run_at) AS ts FROM automation_tasks WHERE deleted_at IS NULL AND enabled = 1' +
          ' AND status = ? AND next_run_at IS NOT NULL'
      )
      .get('enabled') as { ts: number | null } | undefined
    return row?.ts ?? null
  }
  /** 软删除（保留运行历史） */
  softDelete(userId: string, id: string, now: number): number {
    const result = this.db
      .prepare(
        'UPDATE automation_tasks SET deleted_at = ?, enabled = 0, next_run_at = NULL, updated_at = ? ' +
          'WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      )
      .run(now, now, userId, id)
    return result.changes
  }

  /** 暂停 / 继续（继续时由 service 传入重算后的 nextRunAt） */
  setEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    opts: { nextRunAt: number | null; status: TaskStatus; now: number }
  ): AutomationTaskRecord {
    const result = this.db
      .prepare(
        'UPDATE automation_tasks SET enabled = ?, status = ?, next_run_at = ?, updated_at = ? ' +
          'WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
      )
      .run(enabled ? 1 : 0, opts.status, opts.nextRunAt, opts.now, userId, id)
    if (result.changes === 0) throw new Error('任务不存在或已被删除')
    const updated = this.getById(userId, id)
    if (!updated) throw new Error('任务状态更新失败')
    return updated
  }

  /** 只更新排期（运行前后调用） */
  setNextRunAt(id: string, nextRunAt: number | null, status?: TaskStatus, now?: number): void {
    if (status) {
      this.db
        .prepare(
          'UPDATE automation_tasks SET next_run_at = ?, status = ?, updated_at = ? WHERE id = ?'
        )
        .run(nextRunAt, status, now ?? Date.now(), id)
      return
    }
    this.db
      .prepare('UPDATE automation_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt, now ?? Date.now(), id)
  }

  /** 运行计数与最近状态（成功失败都记） */
  bumpRunCounters(id: string, ok: boolean, status: RunStatus, at: number): void {
    this.db
      .prepare(
        'UPDATE automation_tasks SET ' +
          'run_count = run_count + 1, ' +
          'fail_count = fail_count + ?, ' +
          'last_run_at = ?, last_run_status = ?, updated_at = ? ' +
          'WHERE id = ?'
      )
      .run(ok ? 0 : 1, at, status, at, id)
  }
}
