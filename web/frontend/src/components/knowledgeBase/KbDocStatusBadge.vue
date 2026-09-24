<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircle2, Loader2, CircleAlert, Minus, Ban } from 'lucide-vue-next'
import type { DocStatus } from '@/types/knowledgeBase'
import { DOC_STATUS_CONFIG } from '@/types/knowledgeBase'

const props = defineProps<{
  status: DocStatus
}>()

const config = computed(() => DOC_STATUS_CONFIG[props.status])

const isRunning = computed(
  () => !['queued', 'indexed', 'failed', 'canceled'].includes(props.status),
)

const icon = computed(() => {
  if (isRunning.value) return Loader2
  if (props.status === 'indexed') return CheckCircle2
  if (props.status === 'failed') return CircleAlert
  if (props.status === 'canceled') return Ban
  return Minus
})
</script>

<template>
  <el-tag :class="['doc-status-badge', config.cls]" size="small" disable-transitions>
    <component :is="icon" :size="12" :class="{ 'spin-icon': isRunning }" />
    <span>{{ config.label }}</span>
  </el-tag>
</template>

<style scoped>
.doc-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  font-size: var(--font-size-xs);
}

.doc-status-queued {
  background: rgba(100, 116, 139, 0.15);
  color: var(--status-draft-text);
  border-color: rgba(100, 116, 139, 0.3);
}

.doc-status-parsing {
  background: rgba(59, 130, 246, 0.15);
  color: var(--status-indexing-text);
  border-color: rgba(59, 130, 246, 0.3);
}

.doc-status-chunking {
  background: rgba(6, 182, 212, 0.15);
  color: var(--status-cyan-text);
  border-color: rgba(6, 182, 212, 0.3);
}

.doc-status-embedding {
  background: rgba(139, 92, 246, 0.15);
  color: var(--status-purple-text);
  border-color: rgba(139, 92, 246, 0.3);
}

.doc-status-bm25 {
  background: rgba(245, 158, 11, 0.15);
  color: var(--status-amber-text);
  border-color: rgba(245, 158, 11, 0.3);
}

.doc-status-extracting {
  background: rgba(236, 72, 153, 0.15);
  color: var(--status-pink-text);
  border-color: rgba(236, 72, 153, 0.3);
}

.doc-status-indexed {
  background: rgba(16, 185, 129, 0.15);
  color: var(--status-ready-text);
  border-color: rgba(16, 185, 129, 0.3);
}

.doc-status-failed {
  background: rgba(244, 63, 94, 0.15);
  color: var(--status-error-text);
  border-color: rgba(244, 63, 94, 0.3);
}

.doc-status-canceled {
  background: rgba(148, 163, 184, 0.15);
  color: var(--foreground-secondary);
  border-color: rgba(148, 163, 184, 0.3);
}

.spin-icon {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
