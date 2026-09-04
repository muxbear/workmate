export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export type NotificationType =
  | 'kb_indexed'
  | 'kb_failed'
  | 'cron_success'
  | 'cron_failed'
  | 'agent_error'
  | 'security'
  | 'system'
  | 'announcement'

export interface NotificationItem {
  id: string
  type: string
  title: string
  content: string
  level: NotificationLevel
  link: string | null
  metadata: Record<string, unknown> | null
  is_read: boolean
  created_at: string
  read_at: string | null
}

export interface NotificationListResponse {
  items: NotificationItem[]
  total: number
  page: number
  page_size: number
}

export type InboxSource = 'announcement' | 'notification'

/** 通知面板中统一展示的条目（公告 + 个人通知）。 */
export interface InboxItem {
  id: string
  source: InboxSource
  title: string
  content: string
  level: NotificationLevel
  link: string | null
  is_read: boolean
  created_at: string
  read_at: string | null
}

/** 管理端通知列表中的用户信息。 */
export interface AdminNotificationUser {
  id: string
  username: string | null
  nickname: string | null
}

export interface AdminNotificationItem extends NotificationItem {
  user: AdminNotificationUser
}

export interface AdminNotificationListResponse {
  items: AdminNotificationItem[]
  total: number
  page: number
  page_size: number
}

export interface NotificationSendPayload {
  title: string
  content?: string
  level?: NotificationLevel
  link?: string | null
  user_ids?: string[]
  department_ids?: string[]
}

export interface NotificationUpdatePayload {
  title?: string
  content?: string
  level?: NotificationLevel
  link?: string | null
  is_read?: boolean
}

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  kb_indexed: '知识库索引',
  kb_failed: '知识库失败',
  cron_success: '定时任务成功',
  cron_failed: '定时任务失败',
  agent_error: '智能体错误',
  security: '安全提醒',
  system: '系统通知',
  announcement: '公告',
  manual: '手动通知',
}
