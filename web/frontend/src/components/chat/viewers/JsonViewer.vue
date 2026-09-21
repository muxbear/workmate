<script setup lang="ts">
import { computed } from 'vue'
import type { DocumentPayload } from '@/types/document'

/** JSON 文档组件：格式化展示；解析失败时回退为原文 */
const props = defineProps<{ payload: DocumentPayload }>()

const invalid = computed(() => {
  try {
    JSON.parse(props.payload.text || '')
    return false
  } catch {
    return true
  }
})

const formatted = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.payload.text || ''), null, 2)
  } catch {
    return props.payload.text || ''
  }
})
</script>

<template>
  <div class="json-viewer">
    <p v-if="invalid" class="json-tip">JSON 解析失败，已按原文展示</p>
    <pre class="json-body">{{ formatted }}</pre>
  </div>
</template>

<style scoped>
.json-viewer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 100%;
}

.json-tip {
  margin: 0;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.json-body {
  margin: 0;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: 'Consolas', 'Monaco', monospace;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
