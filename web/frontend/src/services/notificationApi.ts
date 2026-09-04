import http from '@/services/request'
import type {
  AdminNotificationItem,
  AdminNotificationListResponse,
  NotificationListResponse,
  NotificationSendPayload,
  NotificationUpdatePayload,
} from '@/types/notification'

export async function fetchNotifications(params?: {
  page?: number
  page_size?: number
  type?: string
  is_read?: boolean
}): Promise<NotificationListResponse> {
  const res = await http.get('/notifications', { params })
  return res.data.data as NotificationListResponse
}

export async function fetchUnreadCount(): Promise<number> {
  const res = await http.get('/notifications/unread_count')
  return res.data.data.count as number
}

export async function markNotificationRead(id: string) {
  const res = await http.patch(`/notifications/${id}/read`)
  return res.data
}

export async function markAllNotificationsRead() {
  const res = await http.post('/notifications/read_all')
  return res.data
}

export async function deleteNotification(id: string) {
  const res = await http.delete(`/notifications/${id}`)
  return res.data
}

// ---- 通知管理（管理端） ----

export async function fetchAdminNotifications(params?: {
  page?: number
  page_size?: number
  keyword?: string
  type?: string
  level?: string
  user_id?: string
  is_read?: boolean
}): Promise<AdminNotificationListResponse> {
  const res = await http.get('/admin/notifications', { params })
  return res.data.data as AdminNotificationListResponse
}

export async function sendAdminNotification(
  data: NotificationSendPayload,
): Promise<{ sent: number; recipients: string[] }> {
  const res = await http.post('/admin/notifications/send', data)
  return res.data.data as { sent: number; recipients: string[] }
}

export async function fetchAdminNotification(id: string): Promise<AdminNotificationItem> {
  const res = await http.get(`/admin/notifications/${id}`)
  return res.data.data as AdminNotificationItem
}

export async function updateAdminNotification(
  id: string,
  data: NotificationUpdatePayload,
): Promise<AdminNotificationItem> {
  const res = await http.put(`/admin/notifications/${id}`, data)
  return res.data.data as AdminNotificationItem
}

export async function deleteAdminNotification(id: string) {
  const res = await http.delete(`/admin/notifications/${id}`)
  return res.data
}
