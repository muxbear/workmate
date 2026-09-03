<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationStore } from '@/stores/notification'

const store = useNotificationStore()
const router = useRouter()

const levelColors: Record<string, string> = {
  success: '#6ee7b7',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#60a5fa',
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = (now.getTime() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前'
  return d.toLocaleDateString()
}

async function handleClick(n: any) {
  if (!n.is_read) await store.markRead(n.id)
  if (n.link) router.push(n.link)
}

onMounted(() => {
  if (store.notifications.length === 0) store.loadList()
})
</script>

<template>
  <div class="notification-panel">
    <div class="panel-header">
      <span class="panel-title">通知</span>
      <button v-if="store.unreadCount > 0" class="read-all-btn" @click="store.markAllRead">全部已读</button>
    </div>
    <div class="panel-list">
      <div v-if="store.loading && store.notifications.length === 0" class="empty">加载中...</div>
      <div v-else-if="store.notifications.length === 0" class="empty">暂无通知</div>
      <div
        v-for="n in store.notifications.slice(0, 20)"
        :key="n.id"
        class="notification-item"
        :class="{ unread: !n.is_read }"
        @click="handleClick(n)"
      >
        <span class="dot" :style="{ background: levelColors[n.level] || levelColors.info }" />
        <div class="item-body">
          <div class="item-title">{{ n.title }}</div>
          <div class="item-content">{{ n.content }}</div>
          <div class="item-time">{{ formatTime(n.created_at) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-panel { width: 100%; }
.panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
.panel-title { font-size: 14px; font-weight: 600; color: var(--foreground-primary); }
.read-all-btn { border: none; background: none; color: var(--accent-primary); font-size: 12px; cursor: pointer; }
.read-all-btn:hover { text-decoration: underline; }
.panel-list { max-height: 400px; overflow-y: auto; }
.empty { padding: 32px 0; text-align: center; color: var(--foreground-muted); font-size: 13px; }
.notification-item { display: flex; gap: 10px; padding: 12px 8px; cursor: pointer; border-bottom: 1px solid var(--border-subtle); }
.notification-item:hover { background: var(--surface-secondary); }
.notification-item.unread { background: rgba(96, 165, 250, 0.05); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
.item-body { flex: 1; min-width: 0; }
.item-title { font-size: 13px; font-weight: 500; color: var(--foreground-primary); }
.item-content { font-size: 12px; color: var(--foreground-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-time { font-size: 11px; color: var(--foreground-muted); margin-top: 4px; }
</style>