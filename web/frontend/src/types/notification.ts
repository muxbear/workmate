export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export type NotificationType =
  | 'kb_indexed'
  | 'kb_failed'
  | 'cron_success'
  | 'cron_failed'
  | 'agent_error'
  | 'security'
  | 'system'

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
