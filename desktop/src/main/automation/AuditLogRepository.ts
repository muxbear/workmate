import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'

/** 自动化审计动作 */
export type AutomationAuditAction =
  | 'automation.create'
  | 'automation.update'
  | 'automation.delete'
  | 'automation.enable'
  | 'automation.run'

/**
 * 审计日志（复用库表 audit_logs）
 *
 * 说明：只记录任务 id 与变更范围，不记录完整提示词，避免敏感内容入库。
 */
export class AuditLogRepository {
  constructor(private readonly db: Database.Database) {}

  /** 写入一条审计（失败不抛出，避免影响主流程） */
  record(userId: string, action: AutomationAuditAction, detail: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          'INSERT INTO audit_logs (id, user_id, action, detail, ip_address, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(randomUUID(), userId, action, JSON.stringify(detail), null, Date.now())
    } catch (err) {
      console.warn('[automation] audit log failed:', err)
    }
  }
}
