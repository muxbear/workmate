<script setup lang="ts">
import type { DocumentPayload } from '@/types/document'

/** 图片文档组件（png / jpg / gif / webp / svg 等） */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <div class="image-viewer">
    <img :src="payload.url" :alt="payload.name" class="image-body" />
  </div>
</template>

<style scoped>
.image-viewer {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  min-height: 100%;
}

.image-body {
  max-width: 100%;
  border-radius: var(--radius-lg);
}
</style>
