<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{
  /** 主进程读取并返回的 pdf 字节 */
  document: Uint8Array | ArrayBuffer
  /** 文件名称，用于错误提示 */
  name: string
}>()

const scrollContainer = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const error = ref('')
const pageCount = ref(0)
const scale = ref(1)

let loadingTask: PDFDocumentLoadingTask | null = null
let pdfDocument: PDFDocumentProxy | null = null

const cmapBaseUrl = new URL('assets/pdfjs/cmaps/', document.baseURI).toString()

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  // pdfjs-dist 在加载时可能把传入的 TypedArray/ArrayBuffer 转移给 worker，
  // 原 buffer 会进入 detached 状态。缩放会触发二次渲染，因此每次都必须复制一份新数据，
  // 避免再次 getDocument 时复用一个已经 detached 的 ArrayBuffer。
  if (input instanceof Uint8Array) return input.slice()
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0))
  throw new Error('无效的 PDF 字节')
}

async function destroyDocument(): Promise<void> {
  try {
    await loadingTask?.destroy()
  } catch {
    // 组件切换时任务可能已经销毁，忽略二次销毁错误
  }
  loadingTask = null
  pdfDocument = null
  pageCount.value = 0
  if (scrollContainer.value) {
    scrollContainer.value.innerHTML = ''
  }
}

async function renderPdf(): Promise<void> {
  await destroyDocument()

  loading.value = true
  error.value = ''

  try {
    loadingTask = getDocument({
      data: toUint8Array(props.document),
      cMapUrl: cmapBaseUrl,
      cMapPacked: true
    })
    pdfDocument = await loadingTask.promise
    pageCount.value = pdfDocument.numPages

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: scale.value })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建 Canvas 上下文')

      await page.render({ canvas, viewport }).promise

      const wrapper = document.createElement('div')
      wrapper.className = 'pdf-preview-page'

      const label = document.createElement('span')
      label.className = 'pdf-preview-page-label'
      label.textContent = `${pageNumber} / ${pdfDocument.numPages}`

      wrapper.appendChild(label)
      wrapper.appendChild(canvas)
      scrollContainer.value?.appendChild(wrapper)

      await page.cleanup()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'PDF 预览失败'
    await destroyDocument()
  } finally {
    loading.value = false
  }
}

function zoomIn(): void {
  scale.value = Math.min(3, scale.value + 0.25)
  void renderPdf()
}

function zoomOut(): void {
  scale.value = Math.max(0.5, scale.value - 0.25)
  void renderPdf()
}

watch(() => props.document, () => void renderPdf(), { immediate: true })

onBeforeUnmount(() => {
  void destroyDocument()
})
</script>

<template>
  <div class="pdf-preview">
    <div class="pdf-preview-toolbar">
      <span class="pdf-preview-name" :title="name">{{ name }}</span>
      <span class="pdf-preview-scale">{{ Math.round(scale * 100) }}%</span>
      <button class="pdf-preview-btn" :disabled="loading || !pageCount" @click="zoomOut">缩小</button>
      <button class="pdf-preview-btn" :disabled="loading || !pageCount" @click="zoomIn">放大</button>
    </div>

    <div v-if="loading" class="pdf-preview-tip">加载中…</div>
    <p v-else-if="error" class="pdf-preview-error">{{ error }}</p>
    <div v-show="!loading && !error" ref="scrollContainer" class="pdf-preview-scroll"></div>
  </div>
</template>

<style scoped>
.pdf-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #e9eef4;
}

.pdf-preview-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(8, 145, 178, 0.1);
  background: #f7f9fb;
  flex-shrink: 0;
}

.pdf-preview-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  color: #1a2332;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pdf-preview-scale {
  font-size: 11px;
  color: #64748b;
  flex-shrink: 0;
}

.pdf-preview-btn {
  border: 1px solid rgba(8, 145, 178, 0.16);
  border-radius: 7px;
  background: #ffffff;
  color: #475569;
  font-size: 11px;
  font-family: inherit;
  padding: 4px 8px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.pdf-preview-btn:hover:not(:disabled) {
  background: rgba(8, 145, 178, 0.08);
  color: #0e7490;
}

.pdf-preview-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.pdf-preview-tip,
.pdf-preview-error {
  margin: 0;
  padding: 20px 8px;
  font-size: 12px;
  text-align: center;
}

.pdf-preview-tip {
  color: #9ca3af;
}

.pdf-preview-error {
  color: #ef4444;
}

.pdf-preview-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pdf-preview-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.pdf-preview-page-label {
  font-size: 10px;
  color: #64748b;
}

.pdf-preview-page canvas {
  max-width: 100%;
  border-radius: 6px;
  box-shadow: 0 4px 18px rgba(15, 23, 42, 0.14);
  background: #ffffff;
}
</style>
