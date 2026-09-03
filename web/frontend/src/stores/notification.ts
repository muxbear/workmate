import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ElNotification } from 'element-plus'
import type { NotificationItem } from '@/types/notification'
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from '@/services/notificationApi'
import { getAccessToken } from '@/services/request'

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref<NotificationItem[]>([])
  const unreadCount = ref(0)
  const loading = ref(false)
  let sseSource: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let sseConnected = ref(false)

  async function loadList() {
    loading.value = true
    try {
      const res = await fetchNotifications({ page: 1, page_size: 20 })
      notifications.value = res.items
    } finally {
      loading.value = false
    }
  }

  async function refreshUnreadCount() {
    try {
      unreadCount.value = await fetchUnreadCount()
    } catch {
      // ignore
    }
  }

  async function markRead(id: string) {
    await markNotificationRead(id)
    const item = notifications.value.find((n) => n.id === id)
    if (item && !item.is_read) {
      item.is_read = true
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    }
  }

  async function markAllRead() {
    await markAllNotificationsRead()
    notifications.value.forEach((n) => { n.is_read = true })
    unreadCount.value = 0
  }

  async function removeNotification(id: string) {
    await deleteNotification(id)
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
        unreadCount.value++
        notifications.value.unshift({
          id: Date.now().toString(),
          type: data.type,
          title: data.title,
          content: data.content,
          level: data.level,
          link: data.link,
          metadata: null,
          is_read: false,
          created_at: new Date().toISOString(),
          read_at: null,
        })
        ElNotification({
          title: data.title,
          message: data.content,
          type: data.level === 'error' ? 'error' : data.level === 'success' ? 'success' : data.level === 'warning' ? 'warning' : 'info',
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
