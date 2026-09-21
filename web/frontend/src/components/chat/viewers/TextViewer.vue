<script setup lang="ts">
import type { DocumentPayload } from '@/types/document'

/** 纯文本 / 代码文档组件 */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <pre class="text-viewer">{{ payload.text }}</pre>
</template>

<style scoped>
.text-viewer {
  margin: 0;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: 'Consolas', 'Monaco', monospace;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
