import type { WorkspaceRow, WorkspaceSource } from './types'

/**
 * 工作空间存储契约（R8-1 后补抽，2026-10-05）：WorkspaceRepository 的接口。
 *
 * 服务（WorkspaceRegistryService）依赖本接口而非具体类 —— 换实现/注入内存替身
 * 不再需要触碰服务代码。方法签名与实现逐字一致（`implements` 由编译器兜底）。
 */
export interface IWorkspaceStore {
  /** 认领无主工作空间（user_id IS NULL 且非默认空间的遗留行 → 归当前用户；幂等） */
  adoptOrphanWorkspaces(userId: string): void

  /** 用户的工作空间（本人的记录 + 机器级共享的默认空间；按创建时间降序） */
  listForUser(userId: string): WorkspaceRow[]

  /** 全部工作空间记录（机器级，供默认空间迁移时定位位于旧目录内的记录） */
  listAll(): WorkspaceRow[]

  getById(id: string, userId: string): WorkspaceRow | undefined

  /** 按路径查重（默认空间幂等、外部目录重复选择复用）；全局无用户过滤 */
  findByPath(path: string): WorkspaceRow | undefined

  /** 任意默认空间记录（机器级唯一语义下取最早创建的一条作迁移目标） */
  findDefaultSource(): WorkspaceRow | undefined

  /** 迁移工作空间路径（改默认空间目录后跟随新位置；id 不变，会话绑定不失效） */
  updatePath(id: string, path: string): void

  /**
   * 重命名（仅展示名，path 不变；归属校验由服务层先行完成，镜像 updatePath 的分层约定）
   * @returns 实际改写行数（0 = 不存在）
   */
  rename(id: string, name: string): number

  /**
   * 拖拽排序：按 orderedIds 顺序回写 sort_order（0 起，越小越靠前）。
   * WHERE 带 user_id → 默认空间（user_id 恒为 NULL）与他人记录天然写不到。
   * @returns 实际改写行数
   */
  reorder(userId: string, orderedIds: string[]): number

  /** 同名查重（范围同 listForUser：本人 + 默认空间；排除 excludeId 自身） */
  findByName(name: string, userId: string, excludeId: string): WorkspaceRow | undefined

  /** 收敛多余默认记录（仅删记录，磁盘目录保留；保留 keepId 那条） */
  removeOtherDefaults(keepId: string): void

  /** 无主记录定向接管（外部目录重复选择时把 NULL 记录归属当前用户；幂等） */
  adoptByPath(path: string, userId: string): void

  create(input: {
    name: string
    path: string
    source: WorkspaceSource
    userId: string | null
  }): WorkspaceRow

  /** 删除本人记录；返回删除行数（0 = 不存在或非本人） */
  delete(id: string, userId: string): number
}
