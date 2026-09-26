<script setup lang="ts">
/**
 * 管理已分享用户——「我的共享知识」里查看谁接受了分享、单独删除某个用户，
 * 或一次性取消该知识库的全部分享。
 */
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Trash2, UserRound } from 'lucide-vue-next'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { fetchKbShares, readApiError } from '@/services/knowledgeBaseApi'
import { SHARE_STATUS_CONFIG } from '@/types/knowledgeBase'
import type { KB, KBShare } from '@/types/knowledgeBase'
import KbShareLinkPanel from './KbShareLinkPanel.vue'

const props = defineProps<{
  visible: boolean
  kb: KB | null
}>()

const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

const store = useKnowledgeBaseStore()

const shares = ref<KBShare[]>([])
const loading = ref(false)
const busyId = ref<string | null>(null)

watch(() => props.visible, async (v) => {
  if (v && props.kb) await reload()
})

async function reload() {
  if (!props.kb) return
  loading.value = true
  try {
    const res = await fetchKbShares(props.kb.id)
    shares.value = res.items
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
    shares.value = []
  } finally {
    loading.value = false
  }
}

async function removeOne(share: KBShare) {
  if (!props.kb) return
  const name = share.nickname || share.username || share.userId
  try {
    await ElMessageBox.confirm(
      `将移除对「${name}」的分享，对方将立即无法再浏览该知识库。`,
      '确认移除该用户？',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  busyId.value = share.id
  try {
    await store.removeShare(props.kb.id, share.id)
    ElMessage.success('已移除')
    await reload()
    emit('changed')
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    busyId.value = null
  }
}

async function cancelAll() {
  if (!props.kb) return
  try {
    await ElMessageBox.confirm(
      '将取消该知识库的全部分享，所有被分享用户都会立即失去访问权限。',
      '确认取消全部分享？',
      { type: 'warning', confirmButtonText: '取消分享', cancelButtonText: '返回' },
    )
  } catch {
    return
  }
  try {
    await store.cancelShares(props.kb.id)
    ElMessage.success('已取消全部分享')
    emit('close')
    emit('changed')
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="已分享用户"
    width="560px"
    @update:model-value="(v: boolean) => !v && emit('close')"
  >
    <div v-loading="loading" class="manage-body">
      <!-- 链接分享：与"用户"是两条独立的通道，放同一弹窗便于库主集中管理 -->
      <KbShareLinkPanel :kb-id="kb?.id ?? ''" :visible="visible" />

      <div v-if="shares.length" class="share-list">
        <div v-for="s in shares" :key="s.id" class="share-row">
          <div class="share-avatar">
            <img v-if="s.avatar" :src="s.avatar" alt="" />
            <UserRound v-else :size="15" />
          </div>
          <div class="share-info">
            <div class="share-name">{{ s.nickname || s.username || s.userId }}</div>
            <div class="share-meta">
              邀请于 {{ formatTime(s.createdAt) }}
              <template v-if="s.acceptedAt">· 接受于 {{ formatTime(s.acceptedAt) }}</template>
            </div>
          </div>
          <span class="share-perm">{{ s.permission === 'write' ? '可写' : '只读' }}</span>
          <span v-if="s.expiresAt" class="share-expiry">{{ formatTime(s.expiresAt) }} 到期</span>
          <el-tag :class="['share-status', SHARE_STATUS_CONFIG[s.status].cls]" size="small" disable-transitions>
            {{ SHARE_STATUS_CONFIG[s.status].label }}
          </el-tag>
          <button
            class="share-remove"
            :disabled="busyId === s.id"
            title="移除该用户"
            @click="removeOne(s)"
           aria-label="移除该用户">
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
      <el-empty v-else-if="!loading" description="该知识库尚未分享给任何人" />
    </div>

    <template #footer>
      <el-button @click="emit('close')">关闭</el-button>
      <el-button
        v-if="shares.length"
        type="danger"
        plain
        @click="cancelAll"
      >
        取消全部分享
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.share-perm {
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
  flex-shrink: 0;
}

.share-expiry {
  font-size: var(--font-size-xs, 12px);
  color: var(--el-color-warning, #e6a23c);
  flex-shrink: 0;
}

.manage-body {
  max-height: 400px;
  overflow-y: auto;
}

.share-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.share-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-radius: var(--radius-lg);
  transition: background 0.15s;
}

.share-row:hover {
  background: var(--surface-secondary);
}

.share-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  overflow: hidden;
}

.share-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.share-info {
  flex: 1;
  min-width: 0;
}

.share-name {
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-meta {
  color: var(--foreground-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-status {
  flex-shrink: 0;
}

.share-status.share-pending {
  background: rgba(245, 158, 11, 0.15);
  color: #fcd34d;
  border-color: rgba(245, 158, 11, 0.3);
}

.share-status.share-accepted {
  background: rgba(16, 185, 129, 0.15);
  color: #6ee7b7;
  border-color: rgba(16, 185, 129, 0.3);
}

.share-status.share-rejected,
.share-status.share-revoked {
  background: rgba(100, 116, 139, 0.15);
  color: #94a3b8;
  border-color: rgba(100, 116, 139, 0.3);
}

.share-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.share-remove:hover:not(:disabled) {
  background: rgba(244, 63, 94, 0.12);
  color: #f87171;
}

.share-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
