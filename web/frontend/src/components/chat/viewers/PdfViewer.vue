<script setup lang="ts">
import type { DocumentPayload } from '@/types/document'

/** PDF 文档组件：使用浏览器内置阅读器 */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <embed class="pdf-viewer" type="application/pdf" :src="payload.url" title="PDF 文档预览" />
</template>

<style scoped>
.pdf-viewer {
  width: 100%;
  height: 100%;
  min-height: 480px;
  border-radius: var(--radius-lg);
}
</style>
