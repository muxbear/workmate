import http from '@/services/request'
import type { NotificationListResponse } from '@/types/notification'

export async function fetchNotifications(params?: {
  page?: number
  page_size?: number
  type?: string
  is_read?: boolean
}) {
  const res = await http.get('/api/notifications', { params })
  return res.data.data as NotificationListResponse
}

export async function fetchUnreadCount() {
  const res = await http.get('/api/notifications/unread_count')
  return res.data.data.count as number
}

export async function markNotificationRead(id: string) {
  const res = await http.patch('/api/notifications/' + id + '/read')
  return res.data
}

export async function markAllNotificationsRead() {
  const res = await http.post('/api/notifications/read_all')
  return res.data
}

export async function deleteNotification(id: string) {
  const res = await http.delete('/api/notifications/' + id)
  return res.data
}
