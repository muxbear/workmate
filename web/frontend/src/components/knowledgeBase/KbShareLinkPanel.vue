<script setup lang="ts">
/**
 * 链接分享面板（迭代 6 T6.3）。
 *
 * 三件事与"直接暴露一个 URL 输入框"不同，都是刻意的：
 *
 * 1. **明文 token 只出现一次**：后端只存 sha256 摘要，创建响应是拿到链接的**唯一**
 *    机会。所以创建后立刻把完整 URL 摆出来并给"复制"，并提醒关掉就再也看不到；
 * 2. **撤销的语义与直觉相反**：撤销只关闭"再拉新人"的入口，**已经通过它加入的人
 *    保留访问权**。确认框里必须写明，否则库主会以为撤销=收回；
 * 3. **状态由后端算**（active/expired/revoked）：前端自己比时钟会与时区/漂移
 *    打架，出现"显示有效但点进去 404"。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Copy, Link2, Plus, Trash2 } from 'lucide-vue-next'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { readApiError } from '@/services/knowledgeBaseApi'
import type { KBShareLink, ShareExpiresIn } from '@/types/knowledgeBase'

const props = defineProps<{
  kbId: string
  visible: boolean
}>()

const store = useKnowledgeBaseStore()

const links = ref<KBShareLink[]>([])
const loading = ref(false)
const creating = ref(false)
const permission = ref<'read' | 'write'>('read')
const expiresIn = ref<ShareExpiresIn>('never')
/** 刚创建出来的明文链接——只在这里显示一次 */
const freshUrl = ref('')
const busyId = ref<string | null>(null)

const EXPIRES_OPTIONS: { value: ShareExpiresIn; label: string }[] = [
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'never', label: '永久有效' },
]

const STATE_LABEL: Record<KBShareLink['state'], string> = {
  active: '有效',
  expired: '已过期',
  revoked: '已撤销',
}

const activeCount = computed(() => links.value.filter((l) => l.state === 'active').length)

watch(() => props.visible, (v) => {
  if (v) {
    freshUrl.value = ''
    void reload()
  }
})

async function reload() {
  loading.value = true
  try {
    links.value = await store.loadShareLinks(props.kbId)
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (creating.value) return
  creating.value = true
  try {
    const created = await store.createShareLink(props.kbId, {
      permission: permission.value, expiresIn: expiresIn.value,
    })
    // 后端不拼绝对 URL（它不知道自己的公网地址），由前端用当前 origin 拼
    freshUrl.value = `${window.location.origin}${created.path}`
    await reload()
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    creating.value = false
  }
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    ElMessage.success('链接已复制')
  } catch {
    // 剪贴板不可用（非安全上下文等）：把地址亮出来让用户手动复制，别静默失败
    ElMessage.warning('复制失败，请手动选中地址复制')
  }
}

async function handleRevoke(link: KBShareLink) {
  try {
    await ElMessageBox.confirm(
      link.acceptCount > 0
        ? `撤销这条链接？\n\n注意：**已经通过它加入的 ${link.acceptCount} 人不会被移除**，` +
          '撤销只是让链接失效、不能再拉新人。要移除某个人的访问权，请在「已分享用户」里删除他。'
        : '撤销这条链接？撤销后它立即失效，不能再被打开。',
      '撤销分享链接',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  busyId.value = link.id
  try {
    await store.revokeShareLink(props.kbId, link.id)
    if (freshUrl.value) freshUrl.value = ''
    await reload()
    ElMessage.success('链接已撤销')
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    busyId.value = null
  }
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 16)
}
</script>

<template>
  <div class="link-panel">
    <div class="panel-header">
      <Link2 :size="15" />
      <span class="panel-title">链接分享</span>
      <span class="panel-hint">拿到链接的人登录后即可加入</span>
    </div>

    <!-- 创建 -->
    <div class="create-row">
      <el-radio-group v-model="permission" size="small">
        <el-radio value="read">只读</el-radio>
        <el-radio value="write">可写</el-radio>
      </el-radio-group>
      <el-select v-model="expiresIn" size="small" class="expires-select">
        <el-option
          v-for="opt in EXPIRES_OPTIONS"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <button class="btn-create" :disabled="creating" @click="handleCreate">
        <Plus :size="14" />生成链接
      </button>
    </div>

    <!-- 刚生成的链接：明文只出现这一次 -->
    <div v-if="freshUrl" class="fresh-link">
      <div class="fresh-tip">
        请立即复制——链接**只在这里显示一次**（服务端只存摘要，关掉后无法再取回）。
      </div>
      <div class="fresh-row">
        <input class="fresh-input" :value="freshUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
        <button class="btn-copy" @click="copyLink(freshUrl)">
          <Copy :size="14" />复制
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div v-if="loading" class="panel-loading">加载中…</div>
    <div v-else-if="links.length === 0" class="panel-empty">还没有分享链接</div>
    <div v-else class="link-list">
      <div v-for="link in links" :key="link.id" class="link-item" :class="{ 'is-dead': link.state !== 'active' }">
        <span class="link-state" :class="`state-${link.state}`">{{ STATE_LABEL[link.state] }}</span>
        <span class="link-perm">{{ link.permission === 'write' ? '可写' : '只读' }}</span>
        <span class="link-expires">到期 {{ formatTime(link.expiresAt) }}</span>
        <span class="link-count">已加入 {{ link.acceptCount }} 人</span>
        <button
          v-if="link.state === 'active'"
          class="link-revoke"
          :disabled="busyId === link.id"
          title="撤销链接"
          @click="handleRevoke(link)"
         aria-label="撤销链接">
          <Trash2 :size="14" />
        </button>
      </div>
      <div v-if="activeCount === 0" class="panel-hint">当前没有有效的链接</div>
    </div>
  </div>
</template>

<style scoped>
.link-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.panel-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-primary);
}

.panel-hint {
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.create-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.expires-select {
  width: 120px;
}

.btn-create,
.btn-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 6px;
  border: none;
  background: var(--el-color-primary, #409eff);
  color: #fff;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.btn-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-copy {
  background: transparent;
  border: 1px solid var(--border-subtle, #e5e7eb);
  color: var(--foreground-primary);
}

.fresh-link {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--el-color-success-light-9, #f0f9eb);
  border-radius: 6px;
}

.fresh-tip {
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.fresh-row {
  display: flex;
  gap: 8px;
}

.fresh-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 6px;
  font-size: var(--font-size-xs, 12px);
  font-family: inherit;
}

.link-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
}

.link-item.is-dead {
  opacity: 0.6;
}

.link-state {
  font-weight: var(--font-weight-medium);
}

.state-active {
  color: var(--el-color-success, #67c23a);
}

.state-expired,
.state-revoked {
  color: var(--foreground-secondary);
}

.link-count {
  margin-left: auto;
}

.link-revoke {
  display: inline-flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--el-color-danger, #f56c6c);
  cursor: pointer;
}

.panel-loading,
.panel-empty {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
}
</style>
