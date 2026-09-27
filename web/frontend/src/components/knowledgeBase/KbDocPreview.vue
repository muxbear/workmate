<script setup lang="ts">
/**
 * 文档标签页：预览**原始文件**的内容。
 *
 * 取的是上传时那一份字节（`POST .../documents/{id}/download`），按类型交给对话页
 * 同一套文档组件渲染：PDF 走浏览器阅读器、图片 / 视频直接显示、HTML 走沙箱
 * iframe、文本类按文本渲染。切片详情是另一回事（见 KbDocDetailDrawer），
 * 这里不再默认展示它——用户点开一篇文档想看的是文件本身。
 *
 * **Markdown 不走共用的 MarkdownViewer**：那个组件为了让 agent 产物里的
 * `<video>` / 相对配图能用，`marked` 之后直接 `v-html`（见它的注释）。知识库的
 * md 是用户上传的任意内容，套那条通路等于把存储型 XSS 重新打开（本模块的
 * KbDocDetailDrawer 已经因为同一类问题中过一次招），所以这里用先转义再解析的
 * `renderSafeMarkdown`。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, FileQuestion, Layers, Loader2, RotateCw, ScrollText } from 'lucide-vue-next'
import type { KBDoc, DocType } from '@/types/knowledgeBase'
import { downloadDocument, fetchDocumentBlob, readApiError } from '@/services/knowledgeBaseApi'
import { resolveDocumentType } from '@/utils/documentType'
import { viewerFor } from '@/components/chat/viewers'
import { renderSafeMarkdown } from '@/utils/markdownSafe'
import type { DocumentPayload } from '@/types/document'
import { ElMessage } from 'element-plus'
import KbDocDetailDrawer from './KbDocDetailDrawer.vue'

const props = defineProps<{
  kbId: string
  doc: KBDoc
}>()

const { t } = useI18n()

/**
 * 原文 / 切片两种视图，**默认原文**。
 *
 * 切片详情（命中片段、原文对照、token 统计）是排查"为什么这篇检索不到"时唯一的
 * 入口，之前挂在文档列表的「查看详情」上；那条路径改成打开本标签页之后，
 * 若在这里不给入口，这个能力就彻底消失了。默认仍是原文——点开一篇文档想看的
 * 就是文件本身。
 */
const view = ref<'original' | 'chunks'>('original')

/**
 * 知识库文档类型 → MIME。
 *
 * `resolveDocumentType` 优先看扩展名，没有扩展名时才看 MIME——而上传的图片、剪藏
 * 的网页常常没有扩展名，光靠名字会一律落成"二进制"（什么都不显示）。
 */
const MIME_BY_DOC_TYPE: Record<DocType, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  image: 'image/*',
  html: 'text/html',
}

const loading = ref(true)
const error = ref('')
const text = ref('')
const objectUrl = ref('')

const typeInfo = computed(() =>
  resolveDocumentType(props.doc.name, MIME_BY_DOC_TYPE[props.doc.type] ?? ''),
)
/** 二进制类（PDF / 图片 / 视频）交给对应组件，其余自己渲染文本 */
const binaryViewer = computed(() => viewerFor(typeInfo.value.kind))
const isMarkdown = computed(() => typeInfo.value.kind === 'markdown')

const payload = computed<DocumentPayload>(() => ({
  name: props.doc.name,
  kind: typeInfo.value.kind,
  label: typeInfo.value.label,
  text: text.value,
  url: objectUrl.value,
}))

function releaseUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function load() {
  releaseUrl()
  text.value = ''
  error.value = ''
  loading.value = true
  try {
    const blob = await fetchDocumentBlob(props.kbId, props.doc.id)
    // 文本类按文本读（Markdown / HTML / 表格 / 纯文本），二进制类给对象地址
    if (typeInfo.value.text || !typeInfo.value.ready) {
      text.value = await blob.text()
    } else {
      objectUrl.value = URL.createObjectURL(blob)
    }
  } catch (err: unknown) {
    error.value = readApiError(err)
  } finally {
    loading.value = false
  }
}

async function handleDownload() {
  try {
    await downloadDocument(props.kbId, props.doc.id, props.doc.name)
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  }
}

watch(
  () => [props.kbId, props.doc.id],
  () => void load(),
  { immediate: true },
)

onBeforeUnmount(releaseUrl)
</script>

<template>
  <div class="doc-preview">
    <div class="preview-head">
      <div class="preview-head-main">
        <span class="preview-name" :title="doc.name">{{ doc.name }}</span>
        <span class="preview-meta">{{ typeInfo.label }} · {{ doc.size }}</span>
      </div>
      <div class="preview-views">
        <button
          class="preview-action"
          :class="{ 'is-active': view === 'original' }"
          :title="t('knowledge.qa.viewOriginal')"
          :aria-label="t('knowledge.qa.viewOriginal')"
          :aria-pressed="view === 'original'"
          @click="view = 'original'"
        >
          <ScrollText :size="14" />
        </button>
        <button
          class="preview-action"
          :class="{ 'is-active': view === 'chunks' }"
          :title="t('knowledge.qa.viewChunks')"
          :aria-label="t('knowledge.qa.viewChunks')"
          :aria-pressed="view === 'chunks'"
          @click="view = 'chunks'"
        >
          <Layers :size="14" />
        </button>
      </div>
      <button
        class="preview-action"
        :title="t('knowledge.qa.downloadOriginal')"
        :aria-label="t('knowledge.qa.downloadOriginal')"
        @click="handleDownload"
      >
        <Download :size="14" />
      </button>
    </div>

    <!-- 切片视图：复用原有的切片详情（它自带两栏布局与内部滚动） -->
    <KbDocDetailDrawer
      v-if="view === 'chunks'"
      :doc="doc"
      :kb-id="kbId"
      :show-header="false"
      class="preview-chunks"
    />

    <div v-else class="preview-body">
      <div v-if="loading" class="preview-hint">
        <Loader2 :size="16" class="spin" />
        <span>{{ t('knowledge.qa.previewLoading') }}</span>
      </div>

      <div v-else-if="error" class="preview-hint">
        <span class="hint-error">{{ error }}</span>
        <button class="hint-btn" @click="load">
          <RotateCw :size="12" />{{ t('knowledge.qa.retry') }}
        </button>
      </div>

      <!-- Word / Excel / PPT 需要服务端解析成 html 或图片，组件还没接；直说并给下载 -->
      <div v-else-if="!typeInfo.ready" class="preview-hint">
        <FileQuestion :size="28" class="hint-icon" />
        <span>{{ t('knowledge.qa.previewUnsupported', { label: typeInfo.label }) }}</span>
        <button class="hint-btn" @click="handleDownload">
          <Download :size="12" />{{ t('knowledge.qa.downloadOriginal') }}
        </button>
      </div>

      <div v-else-if="isMarkdown" class="markdown-preview" v-html="renderSafeMarkdown(text)" />
      <component v-else :is="binaryViewer" :payload="payload" />
    </div>
  </div>
</template>

<style scoped>
.doc-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.preview-head-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preview-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-meta {
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.preview-action {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.preview-action:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

/* 原文 / 切片切换：两个图标按钮并排，激活的那个高亮 */
.preview-views {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
}

.preview-views .preview-action {
  width: 22px;
  height: 22px;
}

.preview-action.is-active {
  background: var(--accent-primary-light);
  color: var(--accent-primary);
}

/* 切片视图自带滚动，这里只给它高度 */
.preview-chunks {
  flex: 1;
  min-height: 0;
}

.preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.preview-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 12px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.hint-icon {
  opacity: 0.4;
}

.hint-error {
  color: var(--status-error-text, #f87171);
}

.hint-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
}

.hint-btn:hover {
  color: var(--foreground-primary);
  border-color: var(--border-medium);
}

.spin {
  animation: preview-spin 1s linear infinite;
}

@keyframes preview-spin {
  to { transform: rotate(360deg); }
}

/* 原文排版：与对话页的 MarkdownViewer 同一套字号节奏（这边是转义后再解析，
   所以没有复用那个组件） */
.markdown-preview {
  font-size: var(--font-size-md);
  line-height: 1.7;
  color: var(--foreground-primary);
  word-break: break-word;
}

.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3),
.markdown-preview :deep(h4) {
  margin: 14px 0 8px;
  font-weight: var(--font-weight-semibold);
}

.markdown-preview :deep(h1) { font-size: 20px; }
.markdown-preview :deep(h2) { font-size: 17px; }
.markdown-preview :deep(h3) { font-size: 15px; }
.markdown-preview :deep(p) { margin: 8px 0; }

.markdown-preview :deep(ul),
.markdown-preview :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}

.markdown-preview :deep(code) {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.markdown-preview :deep(pre) {
  margin: 10px 0;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  overflow-x: auto;
}

.markdown-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0;
}

.markdown-preview :deep(th),
.markdown-preview :deep(td) {
  border: 1px solid var(--border-subtle);
  padding: 6px 10px;
  text-align: left;
}
</style>
