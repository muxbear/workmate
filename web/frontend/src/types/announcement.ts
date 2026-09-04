import type { NotificationLevel } from './notification'

export type AnnouncementStatus = 'draft' | 'published'

/** 管理端公告条目。 */
export interface AnnouncementItem {
  id: string
  title: string
  content: string
  level: NotificationLevel
  link: string | null
  status: AnnouncementStatus
  created_by: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  read_count: number
}

export interface AnnouncementListResponse {
  items: AnnouncementItem[]
  total: number
  page: number
  page_size: number
}

/** 用户在通知面板看到的公告条目。 */
export interface AnnouncementMineItem {
  id: string
  title: string
  content: string
  level: NotificationLevel
  link: string | null
  is_read: boolean
  created_at: string
  read_at: string | null
}

export interface AnnouncementMineListResponse {
  items: AnnouncementMineItem[]
  total: number
  page: number
  page_size: number
}

export interface AnnouncementWritePayload {
  title: string
  content?: string
  level?: NotificationLevel
  link?: string | null
  status?: AnnouncementStatus
}

export interface AnnouncementQuery {
  page?: number
  page_size?: number
  keyword?: string
  status?: AnnouncementStatus | ''
  level?: NotificationLevel | ''
}
