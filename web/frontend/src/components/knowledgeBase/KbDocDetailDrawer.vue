<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  ChevronLeft, Search, Layers, Network, ChevronUp, ChevronDown,
  Copy, ScrollText, Activity, Check,
} from 'lucide-vue-next'
import type { KBDoc, DocChunk } from '@/types/knowledgeBase'
import { fetchDocumentChunks } from '@/services/knowledgeBaseApi'
import KbDocStatusBadge from './KbDocStatusBadge.vue'
import KbSkeleton from './KbSkeleton.vue'

const props = defineProps<{
  doc: KBDoc
  kbId?: string
}>()

const emit = defineEmits<{
  back: []
}>()

const chunks = ref<DocChunk[]>([])
const search = ref('')
const selectedChunk = ref<DocChunk | null>(null)
const copiedId = ref<string | null>(null)
const loading = ref(true)

onMounted(async () => {
  if (!props.kbId) return
  try {
    chunks.value = await fetchDocumentChunks(props.kbId, props.doc.id)
    if (chunks.value.length > 0) {
      selectedChunk.value = chunks.value[0]
    }
  } finally {
    loading.value = false
  }
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return chunks.value
  return chunks.value.filter(
    (c) =>
      c.content.toLowerCase().includes(q) ||
      c.section.toLowerCase().includes(q),
  )
})

const selectedIdx = computed(() => chunks.value.findIndex((c) => c.id === selectedChunk.value?.id))
const prevChunk = computed(() => selectedIdx.value > 0 ? chunks.value[selectedIdx.value - 1] : null)
const nextChunk = computed(() => selectedIdx.value < chunks.value.length - 1 ? chunks.value[selectedIdx.value + 1] : null)

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 高亮查询词，返回可直接交给 v-html 的字符串。
 *
 * 切片正文来自用户上传的文档（md/html/txt 原文），**必须先转义 HTML**：
 * 此前只转义了正则元字符，上传含 `<img onerror=...>` 的文档再分享出去，
 * 任何打开该文档详情页的人都会执行其中的脚本（存储型 XSS，可直接读走
 * sessionStorage 里的 token）。
 */
function highlightText(text: string, query: string): string {
  const safe = escapeHtml(text)
  const q = query.trim()
  if (!q) return safe
  // 查询词同样先做 HTML 转义，才能匹配到正文里已被转义的字符
  return safe.replace(
    new RegExp(`(${escapeRegExp(escapeHtml(q))})`, 'gi'),
    '<mark class="search-highlight">$1</mark>',
  )
}

function copyChunkContent() {
  if (!selectedChunk.value) return
  navigator.clipboard.writeText(selectedChunk.value.content)
  copiedId.value = selectedChunk.value.id
  setTimeout(() => { copiedId.value = null }, 2000)
}
</script>

<template>
  <div class="doc-detail-view">
    <!-- Header -->
    <div class="detail-header">
      <div class="detail-header-left">
        <button class="back-btn" @click="$emit('back')">
          <ChevronLeft :size="16" />返回文档列表
        </button>
        <div class="header-divider" />
        <div class="doc-title-row">
          <span class="doc-name">{{ doc.name }}</span>
          <KbDocStatusBadge :status="doc.status" />
        </div>
      </div>
      <div class="detail-header-right">
        <span class="header-metric"><Layers :size="14" class="metric-icon layers-icon" />{{ doc.chunks }} 分片</span>
        <span class="header-metric"><Network :size="14" class="metric-icon network-icon" />{{ doc.entities }} 实体</span>
        <span class="header-meta-text">{{ doc.size }} · {{ doc.uploadedAt }}</span>
      </div>
    </div>

    <!-- Split view -->
    <div class="split-layout">
      <!-- Left: chunk list -->
      <div class="chunk-list-panel">
        <div class="search-wrap">
          <Search :size="16" class="search-icon" />
          <input
            v-model="search"
            type="text"
            placeholder="在分片中搜索…"
            class="search-input"
          />
        </div>
        <div class="chunk-count-label">
          显示 {{ filtered.length }} / {{ chunks.length }} 个分片
        </div>
        <div class="chunk-scroll-area">
          <div
            v-for="chunk in filtered"
            :key="chunk.id"
            :class="['chunk-card', { 'chunk-card--sel': selectedChunk?.id === chunk.id }]"
            role="button"
            tabindex="0"
            @click="selectedChunk = chunk"
            @keydown.enter="selectedChunk = chunk"
            @keydown.space.prevent="selectedChunk = chunk"
          >
            <div class="chunk-card-top">
              <div class="chunk-card-badges">
                <span :class="['chunk-index-badge', { 'chunk-index-badge--sel': selectedChunk?.id === chunk.id }]">
                  #{{ chunk.index }}
                </span>
                <span class="chunk-page-ref">{{ chunk.pageRef }}</span>
              </div>
              <span class="chunk-token-count">{{ chunk.tokenCount }} tokens</span>
            </div>
            <div class="chunk-section-label">{{ chunk.section }}</div>
            <p
              class="chunk-content-preview"
              v-html="highlightText(chunk.content, search)"
            />
            <div v-if="chunk.entities.length > 0" class="chunk-entity-tags">
              <span v-for="e in chunk.entities" :key="e" class="entity-tag">{{ e }}</span>
            </div>
          </div>
          <!-- 切片还在路上时不再显示"没有匹配的分片"——那个 loading ref 此前是死状态 -->
          <div v-if="loading" class="chunk-empty">
            <KbSkeleton :rows="4" />
          </div>
          <div v-else-if="filtered.length === 0" class="chunk-empty">
            <Layers :size="24" class="chunk-empty-icon" />
            没有匹配的分片
          </div>
        </div>
      </div>

      <!-- Right: detail & context -->
      <div class="chunk-detail-panel">
        <template v-if="selectedChunk">
          <!-- Metadata bar -->
          <div class="metadata-bar">
            <div class="metadata-items">
              <span class="metadata-item">章节: <strong>{{ selectedChunk.section }}</strong></span>
              <span class="metadata-item">页码: <strong>{{ selectedChunk.pageRef }}</strong></span>
              <span class="metadata-item">Token: <strong>{{ selectedChunk.tokenCount }}</strong></span>
              <span class="metadata-item">字符: <strong>{{ selectedChunk.charCount }}</strong></span>
            </div>
            <div class="metadata-actions">
              <button
                class="nav-btn"
                :disabled="!prevChunk"
                @click="prevChunk && (selectedChunk = prevChunk)"
                title="上一个分片"
               aria-label="上一个分片">
                <ChevronUp :size="14" />
              </button>
              <button
                class="nav-btn"
                :disabled="!nextChunk"
                @click="nextChunk && (selectedChunk = nextChunk)"
                title="下一个分片"
               aria-label="下一个分片">
                <ChevronDown :size="14" />
              </button>
              <button class="nav-btn" title="复制分片内容" @click="copyChunkContent" aria-label="复制分片内容">
                <Check v-if="copiedId === selectedChunk.id" :size="14" class="copy-check-icon" />
                <Copy v-else :size="14" />
              </button>
            </div>
          </div>
          <div v-if="selectedChunk.entities.length > 0" class="metadata-entities">
            <span class="entity-label">实体:</span>
            <span v-for="e in selectedChunk.entities" :key="e" class="entity-tag">{{ e }}</span>
          </div>

          <!-- Original context view -->
          <div class="context-scroll-area">
            <div class="context-card">
              <div class="context-card-header">
                <ScrollText :size="14" class="context-header-icon" />
                原文对照视图
                <span class="context-header-right">分片 {{ selectedChunk.index }} / {{ chunks.length }}</span>
              </div>
              <div class="context-card-body">
                <!-- Previous chunk -->
                <div v-if="prevChunk" class="context-prev">
                  <div class="context-ctx-label">
                    <ChevronUp :size="10" />上文 (#{{ prevChunk.index }} · {{ prevChunk.section }})
                  </div>
                  <p class="context-ctx-text">{{ prevChunk.content }}</p>
                </div>

                <!-- Current chunk -->
                <div class="context-current">
                  <div class="context-current-label">
                    <div class="current-dot" />
                    当前分片 #{{ selectedChunk.index }} · {{ selectedChunk.section }}
                  </div>
                  <p
                    class="context-current-text"
                    v-html="highlightText(selectedChunk.content, search)"
                  />
                </div>

                <!-- Next chunk -->
                <div v-if="nextChunk" class="context-next">
                  <div class="context-ctx-label">
                    <ChevronDown :size="10" />下文 (#{{ nextChunk.index }} · {{ nextChunk.section }})
                  </div>
                  <p class="context-ctx-text">{{ nextChunk.content }}</p>
                </div>
              </div>
            </div>

            <!-- Stats card -->
            <div class="stats-card">
              <h4 class="stats-title"><Activity :size="14" class="stats-title-icon" />分片统计</h4>
              <div class="stats-grid">
                <div class="stat-item">
                  <div class="stat-value">{{ selectedChunk.tokenCount }}</div>
                  <div class="stat-label">Token 数</div>
                </div>
                <div class="stat-item">
                  <div class="stat-value">{{ selectedChunk.charCount }}</div>
                  <div class="stat-label">字符数</div>
                </div>
                <div class="stat-item">
                  <div class="stat-value">{{ selectedChunk.entities.length }}</div>
                  <div class="stat-label">实体数</div>
                </div>
              </div>
              <div class="stats-position">
                <div class="stats-position-header">
                  <span>分片位置</span>
                  <span>{{ selectedChunk.index }} / {{ chunks.length }}</span>
                </div>
                <div class="stats-position-bar">
                  <div
                    class="stats-position-fill"
                    :style="{ width: `${(selectedChunk.index / chunks.length) * 100}%` }"
                  />
                </div>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="detail-empty">
          <Layers :size="32" class="detail-empty-icon" />
          <div>从左侧选择一个分片查看详情</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doc-detail-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

/* Header */
.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.detail-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--foreground-secondary);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: color 0.15s;
}

.back-btn:hover {
  color: var(--foreground-primary);
}

.header-divider {
  width: 1px;
  height: 20px;
  background: var(--border-medium);
}

.doc-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-name {
  font-size: 14px;
  color: #fff;
}

.detail-header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}

.header-metric {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--foreground-secondary);
}

.metric-icon {
  flex-shrink: 0;
}

.layers-icon { color: var(--status-purple-text); }
.network-icon { color: var(--status-ready-text); }

.header-meta-text {
  color: var(--foreground-muted);
}

/* Split layout */
.split-layout {
  display: grid;
  grid-template-columns: 5fr 7fr;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

/* Left panel - chunk list */
.chunk-list-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.search-wrap {
  position: relative;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-secondary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 10px;
  color: var(--foreground-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.search-input::placeholder {
  color: var(--foreground-muted);
}

.search-input:focus {
  border-color: rgba(59, 130, 246, 0.4);
}

.chunk-count-label {
  font-size: 12px;
  color: var(--foreground-muted);
}

.chunk-scroll-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 8px;
}

.chunk-scroll-area::-webkit-scrollbar {
  width: 4px;
}

.chunk-scroll-area::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 2px;
}

/* Chunk cards */
.chunk-card {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.chunk-card:hover {
  border-color: var(--border-medium);
  background: var(--color-bg-input);
}

.chunk-card--sel {
  background: rgba(59, 130, 246, 0.15) !important;
  border-color: rgba(59, 130, 246, 0.4) !important;
}

.chunk-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.chunk-card-badges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chunk-index-badge {
  font-size: 10px;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border-radius: 4px;
  background: var(--surface-inset-soft);
  color: var(--foreground-secondary);
  border: 1px solid var(--border-medium);
}

.chunk-index-badge--sel {
  background: rgba(59, 130, 246, 0.2);
  color: var(--status-indexing-text);
  border-color: rgba(59, 130, 246, 0.4);
}

.chunk-page-ref {
  font-size: 10px;
  color: var(--foreground-muted);
}

.chunk-token-count {
  font-size: 10px;
  color: var(--foreground-muted);
}

.chunk-section-label {
  font-size: 10px;
  color: var(--foreground-muted);
  margin-bottom: 4px;
}

.chunk-content-preview {
  margin: 0;
  font-size: 12px;
  color: var(--foreground-secondary);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.search-highlight {
  background: rgba(250, 204, 21, 0.3);
  color: var(--status-highlight-text);
  padding: 0 2px;
  border-radius: 2px;
}

.chunk-entity-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.entity-tag {
  font-size: 9px;
  padding: 0 6px;
  height: 14px;
  line-height: 14px;
  border-radius: 4px;
  background: rgba(168, 85, 247, 0.1);
  color: var(--status-purple-text);
  border: 1px solid rgba(168, 85, 247, 0.2);
}

.chunk-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  color: var(--foreground-muted);
  font-size: 13px;
  gap: 8px;
}

.chunk-empty-icon {
  opacity: 0.4;
}

/* Right panel */
.chunk-detail-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.metadata-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 12px;
}

.metadata-items {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
}

.metadata-item {
  color: var(--foreground-secondary);
}

.metadata-item strong {
  color: var(--foreground-primary);
}

.metadata-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s;
}

.nav-btn:hover:not(:disabled) {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.copy-check-icon {
  color: #10b981;
}

.metadata-entities {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}

.entity-label {
  font-size: 10px;
  color: var(--foreground-muted);
}

/* Context view */
.context-scroll-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.context-scroll-area::-webkit-scrollbar {
  width: 4px;
}

.context-scroll-area::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 2px;
}

.context-card {
  border-radius: 12px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-medium);
  overflow: hidden;
}

.context-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: var(--surface-inset);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--foreground-secondary);
}

.context-header-icon {
  color: var(--status-indexing-text);
}

.context-header-right {
  margin-left: auto;
  color: var(--foreground-muted);
}

.context-card-body {
  padding: 16px;
}

.context-prev,
.context-next {
  border-left: 2px solid var(--border-medium);
  padding-left: 16px;
  padding-top: 12px;
  padding-bottom: 12px;
}

.context-ctx-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--foreground-muted);
  margin-bottom: 6px;
}

.context-ctx-text {
  margin: 0;
  font-size: 13px;
  color: var(--foreground-muted);
  line-height: 1.6;
}

.context-current {
  border-left: 2px solid #3b82f6;
  padding-left: 16px;
  padding-top: 16px;
  padding-bottom: 16px;
  background: rgba(59, 130, 246, 0.05);
  border-radius: 0 8px 8px 0;
  margin: 4px 0;
}

.context-current-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--status-indexing-text);
  margin-bottom: 8px;
}

.current-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b82f6;
  animation: dot-pulse 1.5s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.context-current-text {
  margin: 0;
  font-size: 14px;
  color: var(--foreground-primary);
  line-height: 1.6;
}

/* Stats card */
.stats-card {
  margin-top: 12px;
  padding: 16px;
  background: var(--surface-secondary);
  border: 1px solid var(--border-medium);
  border-radius: 12px;
}

.stats-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--foreground-secondary);
  margin: 0 0 12px;
}

.stats-title-icon {
  color: var(--status-indexing-text);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 12px;
}

.stat-item {
  text-align: center;
  padding: 12px;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--foreground-primary);
}

.stat-label {
  font-size: 10px;
  color: var(--foreground-muted);
  margin-top: 2px;
}

.stats-position-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--foreground-muted);
  margin-bottom: 4px;
}

.stats-position-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--surface-inset);
  overflow: hidden;
}

.stats-position-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6);
  transition: width 0.3s ease;
}

/* Empty state */
.detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--foreground-muted);
  font-size: 13px;
  gap: 8px;
}

.detail-empty-icon {
  opacity: 0.4;
}
</style>
