<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'
import type { KnowledgeBaseSummary, KnowledgeStats } from '../../../../shared/contracts'

/**
 * 知识库概览弹窗
 *
 * 展示文件维度的统计（知识库数 / 文件数 / 占用空间 / 最近更新）。
 * 切片数与实体数属于索引能力，未实现前不展示假数据。
 */
const props = defineProps<{
  open: boolean
  stats: KnowledgeStats | null
  libraries: KnowledgeBaseSummary[]
}>()

const emit = defineEmits<{
  close: []
}>()

const visible = ref(props.open)
watch(
  () => props.open,
  (open) => {
    visible.value = open
  },
  { immediate: true }
)

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const cards = computed(() => [
  { label: '知识库', value: String(props.stats?.kbCount ?? props.libraries.length) },
  { label: '文件', value: String(props.stats?.docCount ?? 0) },
  { label: '占用空间', value: formatSize(props.stats?.sizeBytes ?? 0) },
  { label: '最近更新', value: formatTime(props.stats?.latestUpdatedAt ?? 0) }
])

/** 按文件数排序的知识库列表（概览里看一眼谁最“重”） */
const ranked = computed(() =>
  [...props.libraries].sort((a, b) => b.docsCount - a.docsCount || b.updatedAt - a.updatedAt)
)

function closeModal(): void {
  emit('close')
}

</script>

<template>
  <ModalShell :visible="visible" width="min(560px, calc(100vw - 48px))" aria-label="知识库概览" @close="closeModal">
    <template #header>
      <div>
        <h2 class="ko-title">知识库概览</h2>
        <p class="ko-subtitle">文件维度统计；切片与实体随索引能力提供</p>
      </div>
    </template>

    <div class="ko-body">
      <div class="ko-cards">
        <div v-for="card in cards" :key="card.label" class="ko-stat">
          <span class="ko-stat-value">{{ card.value }}</span>
          <span class="ko-stat-label">{{ card.label }}</span>
        </div>
      </div>

      <section class="ko-section">
        <p class="ko-section-title">按文件数排序</p>
        <ul class="ko-list">
          <li v-for="item in ranked" :key="item.id" class="ko-item">
            <span class="ko-item-name">{{ item.name }}</span>
            <span class="ko-item-desc">{{ item.description || '—' }}</span>
            <span class="ko-item-meta">
              {{ item.docsCount }} 份 · {{ formatSize(item.sizeBytes) }} · {{ formatTime(item.updatedAt) }}
            </span>
          </li>
          <li v-if="!ranked.length" class="ko-empty">还没有知识库</li>
        </ul>
      </section>
    </div>

    <template #footer>
      <button class="ko-btn" type="button" @click="closeModal">关闭</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.ko-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ko-subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.ko-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px;
}

.ko-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.ko-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
}

.ko-stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ko-stat-label {
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ko-section {
  margin-top: 20px;
}

.ko-section-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ko-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ko-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--kw-color-border-soft);
}

.ko-item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text);
}

.ko-item-desc {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.ko-item-meta {
  font-size: 12px;
  color: var(--kw-color-text-faint);
  white-space: nowrap;
}

.ko-empty {
  padding: 12px;
  font-size: 13px;
  color: var(--kw-color-text-faint);
}

.ko-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: none;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.ko-btn:hover {
  opacity: 0.92;
}

</style>
