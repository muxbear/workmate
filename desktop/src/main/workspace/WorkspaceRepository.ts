import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import type { WorkspaceRow, WorkspaceSource } from './types'
import type { IWorkspaceStore } from './IWorkspaceStore'

interface WorkspaceRowDb {
  id: string
  name: string
  path: string
  source: WorkspaceSource
  user_id: string | null
  created_at: number
  sort_order: number
}

function toWorkspaceRow(row: WorkspaceRowDb): WorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    source: row.source,
    userId: row.user_id,
    createdAt: row.created_at,
    sortOrder: row.sort_order
  }
}

const SELECT_WS =
  'SELECT id, name, path, source, user_id, created_at, sort_order FROM workspaces'

/**
 * 用户可见范围谓词：本人的记录 + 机器级共享的默认空间记录
 * （默认空间目录全局唯一，记录 user_id 恒为 NULL 由所有用户共享）
 */
const WS_SCOPE = "(user_id = ? OR (user_id IS NULL AND source = 'default'))"

/** 工作空间仓储：workspaces 表 CRUD（better-sqlite3 prepared statement；契约见 IWorkspaceStore） */
export class WorkspaceRepository implements IWorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * 用户的工作空间（按创建时间降序）
   * 先接管无主旧数据：user_id 为 NULL 且非默认空间的存量记录归属当前用户（幂等）
   */
  /**
   * 认领无主工作空间（user_id IS NULL 且非默认空间的遗留行 → 归当前用户）。
   * 曾内联在 listForUser 里（查询夹带写，违反 CQS）；显式调用方：WorkspaceService.list。
   */
  adoptOrphanWorkspaces(userId: string): void {
    this.db
      .prepare(`UPDATE workspaces SET user_id = ? WHERE user_id IS NULL AND source != 'default'`)
      .run(userId)
  }

  listForUser(userId: string): WorkspaceRow[] {
    // 顺序唯一权威：默认空间恒置顶（不参与 sort_order）→ 拖拽位 → 旧规则（创建时间降序，
    // rowid DESC 作为同毫秒时间戳的 tiebreaker）。存量行 sort_order 全 0，退化为旧顺序。
    const rows = this.db
      .prepare(
        `${SELECT_WS} WHERE ${WS_SCOPE} ` +
          `ORDER BY (source = 'default') DESC, sort_order ASC, created_at DESC, rowid DESC`
      )
      .all(userId) as WorkspaceRowDb[]
    return rows.map(toWorkspaceRow)
  }

  /** 全部工作空间记录（机器级，供默认空间迁移时定位位于旧目录内的记录） */
  listAll(): WorkspaceRow[] {
    const rows = this.db
      .prepare(SELECT_WS + ' ORDER BY created_at ASC, rowid ASC')
      .all() as WorkspaceRowDb[]
    return rows.map(toWorkspaceRow)
  }

  getById(id: string, userId: string): WorkspaceRow | undefined {
    const row = this.db.prepare(`${SELECT_WS} WHERE id = ? AND ${WS_SCOPE}`).get(id, userId) as
      | WorkspaceRowDb
      | undefined
    return row ? toWorkspaceRow(row) : undefined
  }

  /** 按路径查重（默认空间幂等、外部目录重复选择复用）；全局无用户过滤 */
  findByPath(path: string): WorkspaceRow | undefined {
    const row = this.db.prepare(`${SELECT_WS} WHERE path = ?`).get(path) as
      | WorkspaceRowDb
      | undefined
    return row ? toWorkspaceRow(row) : undefined
  }

  /** 任意默认空间记录（机器级唯一语义下取最早创建的一条作迁移目标） */
  findDefaultSource(): WorkspaceRow | undefined {
    const row = this.db
      .prepare(`${SELECT_WS} WHERE source = 'default' ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get() as WorkspaceRowDb | undefined
    return row ? toWorkspaceRow(row) : undefined
  }

  /** 迁移工作空间路径（改默认空间目录后跟随新位置；id 不变，会话绑定不失效） */
  updatePath(id: string, path: string): void {
    this.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(path, id)
  }

  /** 收敛多余默认记录（仅删记录，磁盘目录保留；保留 keepId 那条） */
  removeOtherDefaults(keepId: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE source = 'default' AND id != ?").run(keepId)
  }

  /** 无主记录定向接管（外部目录重复选择时把 NULL 记录归属当前用户；幂等） */
  adoptByPath(path: string, userId: string): void {
    this.db
      .prepare('UPDATE workspaces SET user_id = ? WHERE path = ? AND user_id IS NULL')
      .run(userId, path)
  }

  create(input: {
    name: string
    path: string
    source: WorkspaceSource
    userId: string | null
  }): WorkspaceRow {
    const id = randomUUID()
    const now = Date.now()
    // 新空间排在可排序区最前（保住既有「新建即靠前」体验）：取全局 MIN(sort_order) - 1
    const sortOrder = input.source === 'default' ? 0 : this.nextTopSortOrder()
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, path, source, user_id, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.name, input.path, input.source, input.userId, now, sortOrder)
    return {
      id,
      name: input.name,
      path: input.path,
      source: input.source,
      userId: input.userId,
      createdAt: now,
      sortOrder
    }
  }

  /**
   * 下一个置顶位：全局 MIN(sort_order) - 1（非默认行）。
   * 用全局 MIN 是充分的：每个用户只看见自己的行 + 默认空间，
   * 全局 MIN 单调递减 ⇒ "严格小于所有既有行"对本用户必然成立。
   */
  private nextTopSortOrder(): number {
    const row = this.db
      .prepare("SELECT MIN(sort_order) AS minSort FROM workspaces WHERE source != 'default'")
      .get() as { minSort: number | null }
    return (row.minSort ?? 0) - 1
  }

  /** 重命名（仅展示名；镜像 updatePath：不带 user_id 条件，归属由服务层守卫） */
  rename(id: string, name: string): number {
    return this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id).changes
  }

  /** 拖拽排序：按传入顺序回写 sort_order（镜像 knowledge 的 reorderBases） */
  reorder(userId: string, orderedIds: string[]): number {
    const stmt = this.db.prepare(
      "UPDATE workspaces SET sort_order = ? WHERE id = ? AND user_id = ? AND source != 'default'"
    )
    let changed = 0
    this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        changed += stmt.run(index, id, userId).changes
      })
    })(orderedIds)
    return changed
  }

  /** 同名查重（本人 + 默认空间范围内；排除自身） */
  findByName(name: string, userId: string, excludeId: string): WorkspaceRow | undefined {
    const row = this.db
      .prepare(`${SELECT_WS} WHERE name = ? AND id != ? AND ${WS_SCOPE}`)
      .get(name, excludeId, userId) as WorkspaceRowDb | undefined
    return row ? toWorkspaceRow(row) : undefined
  }

  /** 删除本人记录；返回删除行数（0 = 不存在或非本人） */
  delete(id: string, userId: string): number {
    return this.db
      .prepare('DELETE FROM workspaces WHERE id = ? AND user_id = ?')
      .run(id, userId).changes
  }
}
