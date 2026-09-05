/**
 * 工作空间来源：
 * - created：用户在应用内"新建工作空间"（默认工作空间目录/<name>）
 * - external：用户"打开本地文件夹"选择的任意目录
 * - timestamp：选择"不使用工作空间"时按当前时间自动创建的目录
 * - default：默认工作空间（系统设置"默认工作空间存储路径"所指向的目录）
 */
export type WorkspaceSource = 'created' | 'external' | 'timestamp' | 'default'

/** 工作空间记录（workspaces 表行）；userId 为 NULL 表示机器级共享（默认空间）或无主旧数据 */
export interface WorkspaceRow {
  id: string
  name: string
  path: string
  source: WorkspaceSource
  userId: string | null
  createdAt: number
}
