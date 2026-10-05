import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { KnowledgeShareRow } from './types'

/**
 * 共享仓储（R5：KnowledgeStore 拆 Repository 第一刀，纯搬移）。
 *
 * - SQL 与表结构（knowledge_shares）逐字未动；行映射器随迁；
 * - KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）；
 * - db 句柄经构造注入的 getter 惰性获取 —— 连接与迁移仍归 KnowledgeStore 所有，
 *   仓储不持有连接（与工厂/模式切换无关）。
 */

interface ShareDbRow {
  id: string
  user_id: string
  target_kind: string
  target_id: string
  target_name: string
  token: string
  permission: string
  expires_at: number | null
  revoked_at: number | null
  created_at: number
}

function toShare(row: ShareDbRow): KnowledgeShareRow {
  return {
    id: row.id,
    userId: row.user_id,
    targetKind: row.target_kind as KnowledgeShareRow['targetKind'],
    targetId: row.target_id,
    targetName: row.target_name,
    token: row.token,
    url: `ke-work://share/${row.token}`,
    permission: row.permission,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  }
}

export class ShareRepo {
  constructor(private readonly getDb: () => Database.Database) {}

  insertShare(input: {
    userId: string
    targetKind: KnowledgeShareRow['targetKind']
    targetId: string
    targetName: string
    permission: string
    expiresAt: number | null
  }): KnowledgeShareRow {
    const db = this.getDb()
    const id = randomUUID()
    const token = randomUUID().replace(/-/g, '')
    const now = Date.now()
    db.prepare(
      `INSERT INTO knowledge_shares
        (id, user_id, target_kind, target_id, target_name, token, permission, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(
      id,
      input.userId,
      input.targetKind,
      input.targetId,
      input.targetName,
      token,
      input.permission,
      input.expiresAt,
      now
    )
    return {
      id,
      userId: input.userId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      targetName: input.targetName,
      token,
      url: `ke-work://share/${token}`,
      permission: input.permission,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: now
    }
  }

  listShares(userId: string): KnowledgeShareRow[] {
    const rows = this.getDb()
      .prepare(
        'SELECT * FROM knowledge_shares WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
      )
      .all(userId) as ShareDbRow[]
    return rows.map(toShare)
  }

  /** 撤销共享：返回受影响行数（0 = 不存在或非本人） */
  revokeShare(userId: string, token: string): number {
    return this.getDb()
      .prepare(
        'UPDATE knowledge_shares SET revoked_at = ? WHERE token = ? AND user_id = ? AND revoked_at IS NULL'
      )
      .run(Date.now(), token, userId).changes
  }

  /** 删除某知识库下的全部共享记录（删库时清理） */
  deleteSharesForTarget(userId: string, targetId: string): void {
    this.getDb()
      .prepare('DELETE FROM knowledge_shares WHERE user_id = ? AND target_id = ?')
      .run(userId, targetId)
  }
}
