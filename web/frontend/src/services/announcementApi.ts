import http from '@/services/request'
import type {
  AnnouncementItem,
  AnnouncementListResponse,
  AnnouncementMineListResponse,
  AnnouncementQuery,
  AnnouncementWritePayload,
} from '@/types/announcement'

// ---- 用户公告箱（通知面板使用） ----

export async function fetchMyAnnouncements(params?: {
  page?: number
  page_size?: number
}): Promise<AnnouncementMineListResponse> {
  const res = await http.get('/announcements/mine', { params })
  return res.data.data as AnnouncementMineListResponse
}

export async function fetchAnnouncementUnreadCount(): Promise<number> {
  const res = await http.get('/announcements/unread_count')
  return res.data.data.count as number
}

export async function markAnnouncementRead(id: string) {
  const res = await http.patch(`/announcements/${id}/read`)
  return res.data
}

export async function markAllAnnouncementsRead() {
  const res = await http.post('/announcements/read_all')
  return res.data
}

// ---- 公告管理（管理端） ----

export async function fetchAdminAnnouncements(
  params: AnnouncementQuery,
): Promise<AnnouncementListResponse> {
  const res = await http.get('/admin/announcements', { params })
  return res.data.data as AnnouncementListResponse
}

export async function fetchAdminAnnouncement(id: string): Promise<AnnouncementItem> {
  const res = await http.get(`/admin/announcements/${id}`)
  return res.data.data as AnnouncementItem
}

export async function createAdminAnnouncement(
  data: AnnouncementWritePayload,
): Promise<AnnouncementItem> {
  const res = await http.post('/admin/announcements', data)
  return res.data.data as AnnouncementItem
}

export async function updateAdminAnnouncement(
  id: string,
  data: AnnouncementWritePayload,
): Promise<AnnouncementItem> {
  const res = await http.put(`/admin/announcements/${id}`, data)
  return res.data.data as AnnouncementItem
}

export async function publishAdminAnnouncement(id: string): Promise<AnnouncementItem> {
  const res = await http.post(`/admin/announcements/${id}/publish`)
  return res.data.data as AnnouncementItem
}

export async function deleteAdminAnnouncement(id: string) {
  const res = await http.delete(`/admin/announcements/${id}`)
  return res.data
}
