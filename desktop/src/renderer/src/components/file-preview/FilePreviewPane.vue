<script setup lang="ts">
/**
 * 通用文件预览组件（知识库 / 工作空间共用）
 *
 * 两种用法：
 * 1. **自加载模式**：传 `source`（FilePreviewSource 适配器），组件按扩展名自行读取内容；
 * 2. **受控模式**：直接传 `kind / content / document / loading / error`（工作空间标签页与
 *    流式产物用，内容由调用方持有）。
 *
 * 渲染规则集中在 `previewKind.ts`：markdown → MessageContent；文本 → pre；
 * 图片 / PDF / Word → 对应组件；其余给出「暂不支持预览」提示。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import MessageContent from '../MessageContent.vue'
import {
  getFileExt,
  needsBytes,
  pickPreviewKind,
  unsupportedHint,
  videoMimeType,
  type FilePreviewKind
} from './previewKind'
import type { FilePreviewSource } from './types'

const WordEditor = defineAsyncComponent(() => import('../WordEditor.vue'))
const PdfPreview = defineAsyncComponent(() => import('../PdfPreview.vue'))

const props = withDefaults(
  defineProps<{
    /** 自加载模式：文件来源适配器 */
    source?: FilePreviewSource | null
    /** 受控模式：预览类型（缺省按 name 推断） */
    kind?: FilePreviewKind
    name?: string
    relPath?: string
    content?: string
    truncated?: boolean
    document?: Uint8Array | null
    loading?: boolean
    error?: string
    /** Markdown 内相对图片的解析上下文（工作空间） */
    workspaceId?: string
    /** 是否显示顶部「文件名 + 路径 + 返回」栏 */
    showHeader?: boolean
    /** Word 编辑模式（受控模式） */
    wordMode?: 'view' | 'edit'
  }>(),
  { showHeader: false, wordMode: 'view' }
)

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'update:wordMode', value: 'view' | 'edit'): void
  (e: 'save', bytes: ArrayBuffer): void
}>()

// ── 当前文件的展示信息与渲染类型 ──
const displayName = computed(() => props.source?.name ?? props.name ?? '')
const displayPath = computed(() => props.source?.relPath ?? props.relPath ?? '')
const kind = computed<FilePreviewKind>(() => {
  if (props.source) return pickPreviewKind(props.source.name)
  return props.kind ?? pickPreviewKind(props.name ?? '')
})

// ── 自加载模式：内容状态 ──
const selfLoading = ref(false)
const selfError = ref('')
const selfText = ref('')
const selfTruncated = ref(false)
/** 续读游标：非空表示还有后续内容可继续加载（完整读取大文件） */
const selfCursor = ref<number | null>(null)
const selfTotalChars = ref<number | null>(null)
const moreLoading = ref(false)
const selfBytes = ref<Uint8Array | null>(null)
const objectUrl = ref('')

const isLoading = computed(() => (props.source ? selfLoading.value : props.loading === true))
const errorText = computed(() => (props.source ? selfError.value : (props.error ?? '')))
const textContent = computed(() => (props.source ? selfText.value : (props.content ?? '')))
const truncatedFlag = computed(() =>
  props.source ? selfTruncated.value : props.truncated === true
)
const bytes = computed(() => (props.source ? selfBytes.value : (props.document ?? null)))

/** 是否还有未加载的后续内容 */
const canLoadMore = computed(() => truncatedFlag.value && selfCursor.value !== null)
/** 已加载字符数（大文件提示用） */
const loadedChars = computed(() => selfText.value.length)
/** 全文总字符数提示（转换型文档可提前得知） */
const totalCharsHint = computed(() =>
  selfTotalChars.value === null ? '' : '（全文 ' + selfTotalChars.value + ' 字）'
)
const markdownWorkspaceId = computed(() => props.workspaceId ?? props.source?.markdownWorkspaceId)

const wordModeProxy = computed({
  get: () => props.wordMode ?? 'view',
  set: (value: 'view' | 'edit') => emit('update:wordMode', value)
})

function releaseObjectUrl(): void {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''
  }
}

/** 自加载：按类型读取内容（受控模式下不触发） */
async function load(): Promise<void> {
  const src = props.source
  if (!src) return
  selfLoading.value = true
  selfError.value = ''
  selfText.value = ''
  selfTruncated.value = false
  selfCursor.value = null
  selfTotalChars.value = null
  selfBytes.value = null
  releaseObjectUrl()

  const targetKind = pickPreviewKind(src.name)
  try {
    if (needsBytes(targetKind)) {
      if (!src.readBytes) throw new Error(unsupportedHint(src.name))
      const result = await src.readBytes()
      selfBytes.value = result.bytes
      if (targetKind === 'image' || targetKind === 'video') {
        // BlobPart 是 TS 类型引用（跨 lib 的字节类型收敛），ESLint no-undef 需豁免
        // eslint-disable-next-line no-undef
        const parts = [result.bytes as unknown as BlobPart]
        // 视频必须给对 MIME，否则 <video> 可能拒绝内联播放
        const type = targetKind === 'video' ? videoMimeType(getFileExt(src.name)) : undefined
        objectUrl.value = URL.createObjectURL(type ? new Blob(parts, { type }) : new Blob(parts))
      }
    } else if (targetKind === 'markdown' || targetKind === 'text') {
      const result = await src.readText()
      selfText.value = result.content
      selfTruncated.value = result.truncated === true
      selfCursor.value = typeof result.cursor === 'number' ? result.cursor : null
      selfTotalChars.value = typeof result.totalChars === 'number' ? result.totalChars : null
    }
  } catch (err) {
    selfError.value = err instanceof Error ? err.message : '读取文件失败'
  } finally {
    selfLoading.value = false
  }
}

watch(() => props.source?.key, load, { immediate: true })
onBeforeUnmount(releaseObjectUrl)

/** 读取一页内容：append 为 true 时追加到已加载内容之后 */
async function loadPage(cursor: number | undefined, append: boolean): Promise<boolean> {
  const src = props.source
  if (!src) return false
  const result = await src.readText(cursor)
  selfText.value = append ? selfText.value + result.content : result.content
  selfTruncated.value = result.truncated === true
  selfCursor.value = typeof result.cursor === 'number' ? result.cursor : null
  if (typeof result.totalChars === 'number') selfTotalChars.value = result.totalChars
  return selfTruncated.value
}

/** 继续加载下一页（不整篇重读，避免大文件卡顿） */
async function loadMore(): Promise<void> {
  if (!canLoadMore.value || moreLoading.value) return
  moreLoading.value = true
  try {
    await loadPage(selfCursor.value ?? undefined, true)
  } catch (err) {
    selfError.value = err instanceof Error ? err.message : '读取文件失败'
  } finally {
    moreLoading.value = false
  }
}

/** 连续续读直至读完整篇文档（最多 200 页，防止异常数据造成死循环） */
async function loadAll(): Promise<void> {
  if (!canLoadMore.value || moreLoading.value) return
  moreLoading.value = true
  try {
    let guard = 0
    while (selfTruncated.value && selfCursor.value !== null && guard < 200) {
      guard += 1
      const more = await loadPage(selfCursor.value, true)
      if (!more) break
    }
  } catch (err) {
    selfError.value = err instanceof Error ? err.message : '读取文件失败'
  } finally {
    moreLoading.value = false
  }
}

/** Word 保存：自加载模式写回来源；受控模式交回调用方（保持既有产物逻辑） */
async function onSave(payload: ArrayBuffer): Promise<void> {
  const src = props.source
  if (!src?.saveBytes) {
    emit('save', payload)
    return
  }
  try {
    await src.saveBytes(payload)
    selfError.value = ''
  } catch (err) {
    selfError.value = err instanceof Error ? `保存失败：${err.message}` : '保存失败'
  }
}
</script>

<template>
  <div class="fpp">
    <div v-if="showHeader" class="fpp-head">
      <button class="fpp-back" title="返回列表" @click="emit('back')">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <div class="fpp-title">
        <p class="fpp-name">{{ displayName }}</p>
        <p v-if="displayPath" class="fpp-path">{{ displayPath }}</p>
      </div>
    </div>

    <p v-if="isLoading" class="fpp-tip">加载中…</p>
    <p v-else-if="errorText" class="fpp-error">{{ errorText }}</p>
    <template v-else>
      <div v-if="truncatedFlag" class="fpp-truncated">
        <span v-if="canLoadMore">
          文件较大，已加载 {{ loadedChars }} 字{{ totalCharsHint }}，可继续加载至完整内容
        </span>
        <span v-else>文件较大，仅显示已加载的部分内容</span>
        <span v-if="canLoadMore" class="fpp-truncated-actions">
          <button class="fpp-more-btn" type="button" :disabled="moreLoading" @click="loadMore">
            继续加载
          </button>
          <button class="fpp-more-btn" type="button" :disabled="moreLoading" @click="loadAll">
            加载全部
          </button>
        </span>
      </div>
      <div class="fpp-body">
        <WordEditor
          v-if="kind === 'word' && bytes"
          v-model:mode="wordModeProxy"
          :document="bytes"
          :title="displayName"
          @save="onSave"
        />
        <PdfPreview
          v-else-if="kind === 'pdf' && bytes"
          :document="bytes"
          :name="displayName"
        />
        <img v-else-if="kind === 'image' && objectUrl" class="fpp-image" :src="objectUrl" :alt="displayName" />
        <video
          v-else-if="kind === 'video' && objectUrl"
          class="fpp-video"
          :src="objectUrl"
          :title="displayName"
          controls
          preload="metadata"
        ></video>
        <MessageContent
          v-else-if="kind === 'markdown'"
          :content="textContent"
          content-type="markdown"
          :workspace-id="markdownWorkspaceId"
          :knowledge-id="props.source?.markdownKnowledgeId"
          :base-path="displayPath"
        />
        <pre v-else-if="kind === 'text'" class="fpp-code">{{ textContent }}</pre>
        <p v-else class="fpp-tip">{{ unsupportedHint(displayName) }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fpp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.fpp-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}

.fpp-back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-subtle);
  cursor: pointer;
  flex-shrink: 0;
}

.fpp-back:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.fpp-title {
  flex: 1;
  min-width: 0;
}

.fpp-name {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpp-path {
  margin: 2px 0 0;
  font-size: 10px;
  color: var(--kw-color-text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpp-tip {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  color: var(--kw-color-text-subtle);
}

.fpp-error {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  color: #cf625b;
}

.fpp-truncated {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 6px 12px;
  font-size: 11px;
  color: #b45309;
  background: rgba(245, 158, 11, 0.08);
  border-bottom: 1px solid rgba(245, 158, 11, 0.15);
  flex-shrink: 0;
}

.fpp-truncated-actions {
  display: inline-flex;
  gap: 6px;
  flex-shrink: 0;
}

.fpp-more-btn {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(180, 83, 9, 0.35);
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  color: #b45309;
  cursor: pointer;
}

.fpp-more-btn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.15);
}

.fpp-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.fpp-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.fpp-code {
  margin: 0;
  padding: 12px;
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #334155;
  white-space: pre-wrap;
  word-break: break-all;
}

.fpp-image {
  display: block;
  max-width: 100%;
  margin: 0 auto;
  padding: 8px;
}

.fpp-video {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: 0 auto;
  padding: 8px;
  background: #000;
  border-radius: 8px;
}

.fpp-body :deep(.message-content) {
  padding: 12px 16px;
  /* 预览正文字号与界面正文一致，避免 Markdown 继承浏览器默认 16px 显得偏大 */
  font-size: var(--kw-font-size-content, 13px);
  line-height: 1.7;
}
</style>
