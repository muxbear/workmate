<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { KnowledgeBaseSummary, KnowledgeStats } from '../../../../preload/index.d'

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

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="ko-modal">
    <div v-if="visible" class="ko-mask" @click.self="closeModal">
      <div class="ko-card" role="dialog" aria-modal="true" aria-label="知识库概览">
        <header class="ko-header">
          <div>
            <h2 class="ko-title">知识库概览</h2>
            <p class="ko-subtitle">文件维度统计；切片与实体随索引能力提供</p>
          </div>
          <button class="ko-close" type="button" aria-label="关闭" @click="closeModal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

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

        <footer class="ko-footer">
          <button class="ko-btn" type="button" @click="closeModal">关闭</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ko-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.ko-card {
  display: flex;
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.ko-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

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

.ko-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.ko-close:hover {
  color: var(--kw-color-text);
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

.ko-footer {
  display: flex;
  padding: 0 24px 20px;
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

.ko-modal-enter-active,
.ko-modal-leave-active {
  transition: opacity 0.2s;
}

.ko-modal-enter-from,
.ko-modal-leave-to {
  opacity: 0;
}
</style>
