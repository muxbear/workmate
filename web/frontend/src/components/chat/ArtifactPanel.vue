<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Download, FileQuestion } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { artifactKindLabel, formatFileSize } from '@/utils/format'
import type { ChatArtifact } from '@/types/chat'

/** 会话产物预览面板：图片与文本直接预览，其他类型提供下载。 */
const chatStore = useChatStore()

const previewUrl = ref('')
const previewText = ref('')
const loading = ref(false)

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const TEXT_RE =
  /\.(txt|md|csv|json|xml|ya?ml|log|py|ts|js|tsx|jsx|java|c|h|cpp|go|rs|sh|sql|html|css|ini|toml)$/i

const artifact = computed(() => chatStore.previewArtifact)
const isImage = computed(() => IMAGE_RE.test(artifact.value?.name ?? ''))
const isText = computed(() => TEXT_RE.test(artifact.value?.name ?? ''))

function revoke() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

async function load(target: ChatArtifact | null) {
  revoke()
  previewText.value = ''
  if (!target) return
  loading.value = true
  try {
    const blob = await chatStore.fetchArtifactBlob(target)
    if (!blob) return
    if (isImage.value) previewUrl.value = URL.createObjectURL(blob)
    else if (isText.value) previewText.value = await blob.text()
  } finally {
    loading.value = false
  }
}

watch(artifact, (next) => {
  void load(next)
})

onUnmounted(revoke)
</script>

<template>
  <div class="artifact-panel">
    <div v-if="!artifact" class="artifact-empty">
      <FileQuestion :size="28" />
      <p>点击消息中的产物卡片可在此预览</p>
    </div>
    <template v-else>
      <div class="artifact-head">
        <span class="artifact-title" :title="artifact.path">{{ artifact.name }}</span>
        <button class="artifact-action" title="下载" @click="chatStore.downloadArtifact(artifact)">
          <Download :size="14" />
        </button>
      </div>
      <p class="artifact-path" :title="artifact.path">
        {{ artifactKindLabel(artifact.mime_type) }}
        <template v-if="formatFileSize(artifact.size)">
          · {{ formatFileSize(artifact.size) }}</template
        >
        · {{ artifact.path }}
      </p>
      <div v-if="loading" class="artifact-loading">加载中…</div>
      <div v-else class="artifact-body">
        <img v-if="previewUrl" :src="previewUrl" class="artifact-image" alt="" />
        <pre v-else-if="previewText" class="artifact-text">{{ previewText }}</pre>
        <p v-else class="artifact-hint">该类型暂不支持预览，请下载后查看</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.artifact-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}

.artifact-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.artifact-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.artifact-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-action {
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
}

.artifact-action:hover {
  background: var(--surface-secondary);
  color: var(--accent-primary);
}

.artifact-path {
  margin: 0;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  padding: 8px;
}

.artifact-image {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

.artifact-text {
  margin: 0;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: Consolas, Monaco, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-hint,
.artifact-loading {
  margin: 0;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}
</style>
