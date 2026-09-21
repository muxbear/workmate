<script setup lang="ts">
import { FileClock } from 'lucide-vue-next'
import type { DocumentPayload } from '@/types/document'

/** 规划中的文档组件占位（Word / Excel / PPT / 其他二进制）：先支持下载 */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <div class="pending-viewer">
    <FileClock :size="28" />
    <p class="pending-title">{{ payload.label }} 文档组件规划中</p>
    <p class="pending-desc">该类型需要服务端解析后预览，当前可在右上角下载后用本地应用打开。</p>
  </div>
</template>

<style scoped>
.pending-viewer {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 100%;
  padding: 24px;
  color: var(--foreground-muted);
  text-align: center;
}

.pending-title {
  margin: 0;
  color: var(--foreground-secondary);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.pending-desc {
  margin: 0;
  max-width: 260px;
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
</style>
