<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Volume2,
  Square,
  RotateCcw,
  Download,
  Package,
  FileText,
  Share2,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-vue-next'
import { marked } from 'marked'
import { artifactKindLabel, formatFileSize } from '@/utils/format'
import { buildImageSrcMap } from '@/utils/markdownArtifacts'
import { useArtifactImages } from '@/composables/useArtifactImages'
import { turnLabel } from '@/utils/artifactGroups'
import { useChatStore } from '@/stores/chat'
import { parseBundleTurn } from '@/stores/workspace'
import TraceTree from './TraceTree.vue'
import type { ChatMessage } from '@/types/chat'

const props = defineProps<{
  message: ChatMessage
}>()

const chatStore = useChatStore()
const showReasoning = ref(false)
const copied = ref(false)
const isReading = ref(false)

function handleCopy() {
  navigator.clipboard.writeText(props.message.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function handleReadAloud() {
  const synth = window.speechSynthesis
  if (!synth) return
  if (isReading.value) {
    synth.cancel()
    isReading.value = false
    return
  }
  const utterance = new SpeechSynthesisUtterance(props.message.content)
  utterance.lang = 'zh-CN'
  utterance.onend = () => (isReading.value = false)
  utterance.onerror = () => (isReading.value = false)
  synth.speak(utterance)
  isReading.value = true
}

function handleRegenerate() {
  chatStore.regenerate(props.message.id)
}

const hasBlocks = computed(() => {
  return chatStore.traceEnabled && props.message.blocks && props.message.blocks.length > 0
})

/** 有耗时 / 模型 / 时间时才渲染元信息行，避免历史回显出现空行 */
const hasMeta = computed(() =>
  Boolean(props.message.durationMs || props.message.model || props.message.createdAt),
)

/** 当前消息里的文档产物路径（作为配图相对路径的基准目录） */
const docPath = computed(() => {
  const items = props.message.artifacts ?? []
  const doc = items.find((item) => /\.(md|markdown)$/i.test(item.path))
  return doc?.path ?? ''
})

/** 本轮交付轮次（从文档路径解析），用于「打包下载本轮」 */
const bundleTurn = computed(() => parseBundleTurn(docPath.value))

/** Markdown 属性转义 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 配图需带鉴权拉取字节（<img> 无法携带 Authorization），统一换成 blob 地址 */
const images = useArtifactImages(
  () => (props.message.role === 'user' ? '' : props.message.content),
  () => ({
    threadId: chatStore.threadId,
    basePath: docPath.value,
    artifactPaths: (props.message.artifacts ?? []).map((item) => item.path),
  }),
)

const renderedContent = computed(() => {
  if (props.message.role === 'user') return props.message.content
  if (!props.message.content) return ''

  const imageMap = buildImageSrcMap(props.message.content, {
    threadId: chatStore.threadId,
    basePath: docPath.value,
    artifactPaths: (props.message.artifacts ?? []).map((item) => item.path),
  })
  const renderer = new marked.Renderer()
  renderer.image = ({ href, title, text: alt }) => {
    const raw = href ?? ''
    const src = images.renderSrc(raw, imageMap)
    const attrs = ['src="' + escapeAttr(src) + '"', 'alt="' + escapeAttr(alt ?? '') + '"']
    if (title) attrs.push('title="' + escapeAttr(title) + '"')
    return '<img ' + attrs.join(' ') + '>'
  }
  return marked.parse(props.message.content, { breaks: true, renderer })
})

/** 打包下载本轮交付物（文章 + 同目录配图） */
function handleBundleDownload(): void {
  void chatStore.downloadBundle('turn', bundleTurn.value)
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function handleShare() {
  void navigator.clipboard.writeText(props.message.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

function fileExtension(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0
    ? filename
        .slice(i + 1)
        .toUpperCase()
        .slice(0, 4)
    : 'FILE'
}
</script>

<template>
  <div class="message-item" :class="[message.role, { streaming: message.streaming }]">
    <div class="message-body">
      <div class="message-bubble">
        <!-- Trace mode: hierarchical card view -->
        <TraceTree v-if="hasBlocks" :blocks="message.blocks!" />
        <!-- Normal mode: reasoning section -->
        <div
          v-else-if="message.role === 'assistant' && message.reasoning"
          class="reasoning-section"
        >
          <div class="reasoning-toggle" @click="showReasoning = !showReasoning">
            <Brain :size="12" />
            <span>思考过程</span>
            <ChevronDown v-if="!showReasoning" :size="12" />
            <ChevronRight v-else :size="12" />
          </div>
          <div v-if="showReasoning" class="reasoning-content">
            {{ message.reasoning }}
          </div>
        </div>
        <!-- Normal mode: markdown content -->
        <div
          v-if="!hasBlocks && message.role === 'assistant'"
          class="markdown-body"
          v-html="renderedContent"
        ></div>
        <div v-if="message.role === 'user'">
          <div
            v-if="message.attachments && message.attachments.length > 0"
            class="user-attachments"
          >
            <div v-for="(att, i) in message.attachments" :key="i" class="user-att-item">
              <div class="user-att-icon">
                <img v-if="isImage(att.mimeType)" :src="att.thumbnailUrl" alt="" />
                <span v-else class="user-att-ext">{{ fileExtension(att.filename) }}</span>
              </div>
              <div class="user-att-info">
                <span class="user-att-name">{{ att.filename }}</span>
                <span class="user-att-size">{{ formatFileSize(att.size) }}</span>
              </div>
            </div>
          </div>
          {{ message.content }}
        </div>
        <span v-if="message.streaming && !message.content && !hasBlocks" class="typing-indicator">
          <span class="dot" />
          <span class="dot" />
          <span class="dot" />
        </span>
      </div>
      <div
        v-if="message.role === 'assistant' && message.artifacts && message.artifacts.length > 0"
        class="artifact-list"
      >
        <div class="artifact-head">
          <span class="artifact-head-title">{{ turnLabel(bundleTurn) || '本轮交付物' }}</span>
          <button
            class="artifact-bundle"
            title="打包下载本轮交付物（文章 + 配图）"
            @click.stop="handleBundleDownload"
          >
            <Package :size="12" />
            <span>打包下载</span>
          </button>
        </div>
        <div
          v-for="artifact in message.artifacts"
          :key="artifact.path"
          class="artifact-card"
          :title="artifact.path"
          @click="chatStore.openArtifact(artifact)"
        >
          <FileText :size="14" />
          <span class="artifact-name">{{ artifact.name }}</span>
          <span class="artifact-meta">
            {{ artifactKindLabel(artifact.mime_type) }}
            <template v-if="formatFileSize(artifact.size)">
              · {{ formatFileSize(artifact.size) }}</template
            >
          </span>
          <button
            class="artifact-download"
            title="下载"
            @click.stop="chatStore.downloadArtifact(artifact)"
          >
            <Download :size="12" />
          </button>
        </div>
      </div>
      <div
        class="message-meta"
        v-if="message.role === 'assistant' && !message.streaming && hasMeta"
      >
        <span v-if="formatDuration(message.durationMs)">{{
          formatDuration(message.durationMs)
        }}</span>
        <span v-if="message.model">{{ message.model }}</span>
        <span v-if="message.createdAt">{{ formatTime(message.createdAt) }}</span>
      </div>
      <div v-if="message.role === 'assistant' && !message.streaming" class="message-actions">
        <button class="action-btn" title="复制" @click="handleCopy">
          <Check v-if="copied" :size="14" />
          <Copy v-else :size="14" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: isReading }"
          title="朗读"
          @click="handleReadAloud"
        >
          <Square v-if="isReading" :size="14" />
          <Volume2 v-else :size="14" />
          <span>{{ isReading ? '停止' : '朗读' }}</span>
        </button>
        <button
          class="action-btn"
          title="重答"
          :disabled="chatStore.loading"
          @click="handleRegenerate"
        >
          <RotateCcw :size="14" />
          <span>重答</span>
        </button>
        <button
          class="action-btn"
          :class="{ active: message.feedback === 'up' }"
          title="点赞"
          @click="chatStore.setFeedback(message.id, 'up')"
        >
          <ThumbsUp :size="14" />
        </button>
        <button
          class="action-btn"
          :class="{ active: message.feedback === 'down' }"
          title="点踩"
          @click="chatStore.setFeedback(message.id, 'down')"
        >
          <ThumbsDown :size="14" />
        </button>
        <button class="action-btn" title="分享" @click="handleShare">
          <Share2 :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-item {
  display: flex;
  gap: 10px;
  width: 100%;
  /* 允许 flex 子项收缩：避免长代码块把气泡撑出容器 */
  min-width: 0;
}

.message-item.user {
  justify-content: flex-end;
}

.message-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.message-item.user .message-body {
  max-width: 70%;
}

.message-bubble {
  padding: 12px 16px;
  border-radius: var(--radius-xl);
  font-size: var(--font-size-md);
  line-height: 1.5;
  word-break: break-word;
}

.message-item.user .message-bubble {
  background: var(--accent-primary);
  color: white;
}

.message-item.assistant .message-bubble {
  background: var(--surface-card);
  border: 1px solid var(--border-medium);
  color: var(--foreground-primary);
}

.message-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.message-actions .action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.15s ease;
}

.message-actions .action-btn:hover:not(:disabled) {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.message-actions .action-btn.active {
  color: var(--accent-primary);
}

.message-actions .action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: typing 1.4s infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.2s;
}

.dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing {
  0%,
  60%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  30% {
    opacity: 1;
    transform: scale(1);
  }
}

/* Markdown rendered styles inside assistant bubble */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 12px 0 6px;
  font-weight: var(--font-weight-semibold);
}

.markdown-body :deep(h1) {
  font-size: 18px;
}
.markdown-body :deep(h2) {
  font-size: 16px;
}
.markdown-body :deep(h3) {
  font-size: 15px;
}
.markdown-body :deep(h4) {
  font-size: var(--font-size-md);
}

.markdown-body :deep(p) {
  margin: 6px 0;
  line-height: 1.6;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  margin: 2px 0;
  line-height: 1.5;
}

.markdown-body :deep(code) {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  font-size: 13px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.markdown-body :deep(pre) {
  margin: 8px 0;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  max-width: 100%;
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown-body :deep(blockquote) {
  margin: 6px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--accent-primary);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
  max-width: 100%;
}

.markdown-body :deep(img),
.markdown-body :deep(video) {
  max-width: 100%;
  height: auto;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border-medium);
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--surface-secondary);
  font-weight: var(--font-weight-semibold);
}

.markdown-body :deep(a) {
  color: var(--accent-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 10px 0;
}

.reasoning-section {
  margin-bottom: 8px;
  border-left: 3px solid #a78bfa;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: rgba(167, 139, 250, 0.06);
  font-size: var(--font-size-xs);
  overflow: hidden;
}

.reasoning-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  color: #7c3aed;
  user-select: none;
}

.reasoning-toggle:hover {
  background: rgba(167, 139, 250, 0.1);
}

.reasoning-content {
  padding: 6px 10px 8px 24px;
  color: var(--foreground-muted);
  white-space: pre-wrap;
  word-break: break-word;
  font-style: italic;
  line-height: 1.5;
}

.markdown-body :deep(strong) {
  font-weight: var(--font-weight-semibold);
}

.markdown-body :deep(em) {
  font-style: italic;
}

.user-attachments {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.user-att-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
}

.user-att-icon {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.15);
  flex-shrink: 0;
}

.user-att-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-att-ext {
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.5px;
}

.user-att-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.user-att-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-att-size {
  font-size: 10px;
  opacity: 0.5;
}

.artifact-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.artifact-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.artifact-card:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.artifact-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
  padding: 0;
}

.artifact-download:hover {
  color: var(--accent-primary);
}

.artifact-bundle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.artifact-bundle:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.artifact-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 2px;
}

.artifact-head-title {
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.artifact-meta {
  color: var(--foreground-muted);
  font-size: 10px;
  white-space: nowrap;
}
</style>
