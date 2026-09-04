<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { InboxItem } from '@/types/notification'
import { useNotificationStore } from '@/stores/notification'

const store = useNotificationStore()
const router = useRouter()

const levelColors: Record<string, string> = {
  success: '#6ee7b7',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#60a5fa',
}

const levelLabels: Record<string, string> = {
  success: '成功',
  error: '错误',
  warning: '警告',
  info: '信息',
}

const detailItem = ref<InboxItem | null>(null)
const detailVisible = ref(false)

function openDetail(n: InboxItem) {
  detailItem.value = n
  detailVisible.value = true
}

function goDetailLink() {
  const link = detailItem.value?.link
  if (link) router.push(link)
  detailVisible.value = false
}

function formatFullTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

async function handleClick(n: InboxItem) {
  if (n.source === 'announcement') {
    if (!n.is_read) await store.markRead(n.id)
    openDetail(n)
    return
  }
  if (!n.is_read) await store.markRead(n.id)
  if (n.link) router.push(n.link)
}

onMounted(() => {
  store.loadList()
  store.refreshUnreadCount()
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
          <div class="item-title">
            <span v-if="n.source === 'announcement'" class="item-badge">公告</span>
            <span class="item-title-text">{{ n.title }}</span>
          </div>
          <div class="item-content">{{ n.content }}</div>
          <div class="item-time">{{ formatTime(n.created_at) }}</div>
        </div>
      </div>
    </div>

    <!-- 公告详情弹窗 -->
    <el-dialog v-model="detailVisible" title="公告详情" width="520px" append-to-body>
      <template v-if="detailItem">
        <div class="detail-head">
          <div class="detail-title-row">
            <span class="item-badge">公告</span>
            <span class="detail-title">{{ detailItem.title }}</span>
          </div>
          <div class="detail-meta">
            <span
              class="detail-dot"
              :style="{ background: levelColors[detailItem.level] || levelColors.info }"
            />
            <span class="detail-label">{{ levelLabels[detailItem.level] || '信息' }}</span>
            <span class="detail-time">{{ formatFullTime(detailItem.created_at) }}</span>
          </div>
        </div>
        <div class="detail-content">
          {{ detailItem.content || '（无内容）' }}
        </div>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="detailItem?.link" type="primary" @click="goDetailLink">前往链接</el-button>
      </template>
    </el-dialog>
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
.item-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--foreground-primary); }
.item-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-badge { flex-shrink: 0; padding: 0 5px; border-radius: 4px; background: rgba(96, 165, 250, 0.16); color: #60a5fa; font-size: 10px; line-height: 16px; }
.item-content { font-size: 12px; color: var(--foreground-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-time { font-size: 11px; color: var(--foreground-muted); margin-top: 4px; }
.detail-head { margin-bottom: 14px; }
.detail-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.detail-title { font-size: 16px; font-weight: 600; color: var(--foreground-primary); line-height: 1.4; }
.detail-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--foreground-muted); }
.detail-dot { width: 8px; height: 8px; border-radius: 50%; }
.detail-time { margin-left: 2px; }
.detail-content { max-height: 360px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.7; font-size: 13px; color: var(--foreground-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--surface-secondary); padding: 14px; }
</style>