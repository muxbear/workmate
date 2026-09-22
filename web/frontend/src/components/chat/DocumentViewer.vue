<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Download, Loader2, Package, RefreshCw } from 'lucide-vue-next'
import { downloadArtifact, fetchArtifactBlob } from '@/services/artifactApi'
import { resolveDocumentType } from '@/utils/documentType'
import { formatFileSize } from '@/utils/format'
import { viewerFor } from '@/components/chat/viewers'
import type { DocumentPayload } from '@/types/document'
import { useWorkspaceStore } from '@/stores/workspace'
import { useChatStore } from '@/stores/chat'
import type { DocumentTab } from '@/stores/workspace'

/** 文档标签页内容区：按文档类型加载内容，并交给对应的文档组件渲染 */
const props = defineProps<{ tab: DocumentTab }>()
const workspaceStore = useWorkspaceStore()

const typeInfo = computed(() => resolveDocumentType(props.tab.name, props.tab.mimeType))
const viewer = computed(() => viewerFor(typeInfo.value.kind))

const loading = ref(false)
const failed = ref(false)
const expired = ref(false)
const text = ref('')
const objectUrl = ref('')

const chatStore = useChatStore()

const payload = computed<DocumentPayload>(() => ({
  name: props.tab.name,
  kind: typeInfo.value.kind,
  label: typeInfo.value.label,
  text: text.value,
  url: objectUrl.value,
  threadId: props.tab.threadId,
  basePath: props.tab.path,
  artifactPaths: chatStore.threadArtifacts.map((item) => item.path),
}))

function revokeObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function loadDocument(tab: DocumentTab) {
  revokeObjectUrl()
  text.value = ''
  failed.value = false
  expired.value = false
  // 规划中的文档类型（Word / Excel / PPT 等）暂不拉取内容，直接展示占位组件
  if (!typeInfo.value.ready) return
  loading.value = true
  try {
    const result = await fetchArtifactBlob(tab.threadId, tab.path, 'inline')
    if (!result.ok || !result.blob) {
      // 410 表示持久副本与沙箱均不可用，重试没有意义，直接提示过期
      expired.value = result.expired
      failed.value = !result.expired
      return
    }
    if (typeInfo.value.text) text.value = await result.blob.text()
    else objectUrl.value = URL.createObjectURL(result.blob)
  } finally {
    loading.value = false
  }
}

/** 关闭当前已过期产物的标签页 */
function closeTab() {
  workspaceStore.closeTab(props.tab.key)
}

watch(
  () => props.tab,
  (tab) => {
    if (tab) void loadDocument(tab)
  },
  { immediate: true },
)

onUnmounted(revokeObjectUrl)

function handleDownload() {
  void downloadArtifact(props.tab.threadId, props.tab.path, props.tab.name)
}

/** 打包下载：优先本轮（bundleTurn），否则整个会话 */
function handleBundleDownload(): void {
  const turn = props.tab.bundleTurn
  void chatStore.downloadBundle(turn ? 'turn' : 'thread', turn)
}
</script>

<template>
  <div class="document-viewer">
    <div class="document-head">
      <div class="document-head-main">
        <span class="document-name" :title="tab.path">{{ tab.name }}</span>
        <span class="document-meta">
          {{ typeInfo.label }}
          <template v-if="formatFileSize(tab.size)"> · {{ formatFileSize(tab.size) }}</template>
        </span>
      </div>
      <button
        class="document-action"
        :title="tab.bundleTurn ? '打包下载本轮交付物' : '打包下载整个会话交付物'"
        @click="handleBundleDownload"
      >
        <Package :size="14" />
      </button>
      <button class="document-action" title="下载" @click="handleDownload">
        <Download :size="14" />
      </button>
    </div>

    <div class="document-body">
      <div v-if="loading" class="document-hint">
        <Loader2 :size="16" class="spin" />
        <span>加载中…</span>
      </div>
      <div v-else-if="expired" class="document-hint">
        <span>文件已过期，无法恢复</span>
        <button class="document-retry" @click="closeTab">
          <span>关闭标签页</span>
        </button>
      </div>
      <div v-else-if="failed" class="document-hint">
        <span>文档内容加载失败</span>
        <button class="document-retry" @click="loadDocument(tab)">
          <RefreshCw :size="12" />
          <span>重试</span>
        </button>
      </div>
      <component v-else :is="viewer" :payload="payload" />
    </div>
  </div>
</template>

<style scoped>
.document-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.document-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.document-head-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.document-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-meta {
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
  flex: 0 0 auto;
}

.document-action:hover {
  background: var(--surface-secondary);
  color: var(--accent-primary);
}

.document-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  padding: 10px;
  display: flex;
  flex-direction: column;
}

.document-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.document-retry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
