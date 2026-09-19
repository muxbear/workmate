<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'

/** 会话工作区选择器：对应服务端沙箱内的 /workspace/{id} 目录（桌面版本地工作空间的等价改造）。 */
const chatStore = useChatStore()

const STORAGE_KEY = 'ke-work.chat.workspace'
const open = ref(false)
const creating = ref(false)
const name = ref('')

const presets = [
  { id: '', label: '默认工作区' },
  { id: 'my-files', label: '我的文件（沙箱）' },
]

const currentId = computed(() => chatStore.selection.workspaceId ?? '')
const workspacePath = computed(() => (currentId.value ? '/workspace/' + currentId.value : ''))

const currentLabel = computed(
  () => presets.find((item) => item.id === currentId.value)?.label ?? currentId.value,
)
const customIds = computed(() =>
  currentId.value && !presets.some((item) => item.id === currentId.value) ? [currentId.value] : [],
)

function pick(id: string) {
  chatStore.setSelection({ workspaceId: id || null })
  localStorage.setItem(STORAGE_KEY, id)
  open.value = false
}

function confirmCreate() {
  const slug = name.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  if (!slug) return
  pick(slug)
  creating.value = false
  name.value = ''
}

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) chatStore.setSelection({ workspaceId: saved })
})
</script>

<template>
  <div class="ws-selector">
    <button class="footer-action" @click="open = !open">
      <FolderOpen :size="11" />
      {{ currentLabel }}
    </button>
    <div v-if="open" class="ws-menu">
      <button
        v-for="item in presets"
        :key="item.id || 'default'"
        class="ws-item"
        :class="{ 'ws-item--active': currentId === item.id }"
        @click="pick(item.id)"
      >
        {{ item.label }}
      </button>
      <button v-for="id in customIds" :key="id" class="ws-item ws-item--active" @click="pick(id)">
        {{ id }}
      </button>
      <div class="ws-divider"></div>
      <p v-if="workspacePath" class="ws-hint">产物写入 {{ workspacePath }}/</p>

      <div v-if="creating" class="ws-create">
        <input
          v-model="name"
          class="ws-input"
          placeholder="工作区名称（字母/数字/-_）"
          @keydown.enter.prevent="confirmCreate"
        />
        <button class="ws-item ws-item--confirm" @click="confirmCreate">创建并切换</button>
      </div>
      <button v-else class="ws-item" @click="creating = true">+ 新建工作区</button>
    </div>
  </div>
</template>

<style scoped>
.ws-selector {
  position: relative;
  display: flex;
  align-items: center;
}

.footer-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.footer-action:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.ws-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 220px;
  padding: 4px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  z-index: 210;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ws-item {
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.ws-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.ws-item--active {
  color: var(--accent-primary);
}

.ws-divider {
  margin: 4px 6px;
  border-top: 1px solid var(--border-subtle);
}

.ws-create {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px;
}

.ws-input {
  padding: 6px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
  outline: none;
}

.ws-item--confirm {
  background: var(--accent-primary);
  color: #fff;
  text-align: center;
}

.ws-hint {
  margin: 2px 8px 4px;
  color: var(--foreground-muted);
  font-size: 10px;
  word-break: break-all;
}
</style>
