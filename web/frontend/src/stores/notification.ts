import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElNotification } from 'element-plus'
import type { AnnouncementMineItem } from '@/types/announcement'
import type { InboxItem, NotificationItem } from '@/types/notification'
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from '@/services/notificationApi'
import {
  fetchMyAnnouncements,
  fetchAnnouncementUnreadCount,
  markAnnouncementRead,
  markAllAnnouncementsRead,
  deleteAdminAnnouncement,
} from '@/services/announcementApi'
import { getAccessToken } from '@/services/request'

function toInboxNotification(n: NotificationItem): InboxItem {
  return {
    id: n.id,
    source: 'notification',
    title: n.title,
    content: n.content,
    level: n.level,
    link: n.link,
    is_read: n.is_read,
    created_at: n.created_at,
    read_at: n.read_at,
  }
}

function toInboxAnnouncement(a: AnnouncementMineItem): InboxItem {
  return {
    id: a.id,
    source: 'announcement',
    title: a.title,
    content: a.content,
    level: a.level,
    link: a.link,
    is_read: a.is_read,
    created_at: a.created_at,
    read_at: a.read_at,
  }
}

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref<InboxItem[]>([])
  const unreadCount = ref(0)
  const loading = ref(false)
  let sseSource: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const sseConnected = ref(false)

  async function loadList() {
    loading.value = true
    try {
      const [notificationRes, announcementRes] = await Promise.all([
        fetchNotifications({ page: 1, page_size: 20 }),
        fetchMyAnnouncements({ page: 1, page_size: 20 }),
      ])
      const merged = [
        ...notificationRes.items.map(toInboxNotification),
        ...announcementRes.items.map(toInboxAnnouncement),
      ].sort(
        (a, b) =>
          (b.created_at || '').localeCompare(a.created_at || '') || b.id.localeCompare(a.id),
      )
      notifications.value = merged.slice(0, 40)
    } finally {
      loading.value = false
    }
  }

  async function refreshUnreadCount() {
    try {
      const [notificationCount, announcementCount] = await Promise.all([
        fetchUnreadCount(),
        fetchAnnouncementUnreadCount(),
      ])
      unreadCount.value = notificationCount + announcementCount
    } catch {
      // ignore
    }
  }

  async function markRead(id: string) {
    const item = notifications.value.find((n) => n.id === id)
    if (!item) return
    if (item.source === 'announcement') {
      await markAnnouncementRead(id)
    } else {
      await markNotificationRead(id)
    }
    if (!item.is_read) {
      item.is_read = true
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    }
  }

  async function markAllRead() {
    await Promise.all([markAllNotificationsRead(), markAllAnnouncementsRead()])
    notifications.value.forEach((n) => {
      n.is_read = true
    })
    unreadCount.value = 0
  }

  async function removeNotification(id: string) {
    const item = notifications.value.find((n) => n.id === id)
    if (!item) return
    if (item.source === 'announcement') {
      await deleteAdminAnnouncement(id)
    } else {
      await deleteNotification(id)
    }
    const idx = notifications.value.findIndex((n) => n.id === id)
    if (idx >= 0) {
      if (!notifications.value[idx].is_read) {
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
      notifications.value.splice(idx, 1)
    }
  }

  function connectSSE() {
    disconnectSSE()
    const token = getAccessToken()
    if (!token) return
    const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
    const url = baseURL + '/notifications/stream?token=' + encodeURIComponent(token)
    sseSource = new EventSource(url)
    sseSource.onopen = () => {
      sseConnected.value = true
      stopPolling()
    }
    sseSource.onerror = () => {
      sseConnected.value = false
      sseSource?.close()
      sseSource = null
      startPolling()
    }
    sseSource.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        const isAnnouncement = data.source === 'announcement'
        const unreadId = isAnnouncement
          ? String(data.announcement_id || Date.now())
          : Date.now().toString()
        const popupType: 'success' | 'warning' | 'error' | 'info' =
          data.level === 'error'
            ? 'error'
            : data.level === 'success'
              ? 'success'
              : data.level === 'warning'
                ? 'warning'
                : 'info'
        unreadCount.value++
        notifications.value.unshift({
          id: unreadId,
          source: isAnnouncement ? 'announcement' : 'notification',
          title: data.title,
          content: data.content,
          level: data.level,
          link: data.link,
          is_read: false,
          created_at: new Date().toISOString(),
          read_at: null,
        })
        ElNotification({
          title: isAnnouncement ? '新公告：' + data.title : data.title,
          message: data.content,
          type: popupType,
          position: 'bottom-right',
        })
      } catch {
        // ignore parse error
      }
    }
  }

  function disconnectSSE() {
    if (sseSource) {
      sseSource.close()
      sseSource = null
    }
    sseConnected.value = false
    stopPolling()
  }

  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      refreshUnreadCount()
    }, 30000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function init() {
    await refreshUnreadCount()
    await loadList()
    connectSSE()
  }

  return {
    notifications,
    unreadCount,
    loading,
    loadList,
    refreshUnreadCount,
    markRead,
    markAllRead,
    removeNotification,
    connectSSE,
    disconnectSSE,
    init,
  }
})
