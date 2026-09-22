<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import { buildImageSrcMap } from '@/utils/markdownArtifacts'
import { useArtifactImages } from '@/composables/useArtifactImages'
import type { DocumentPayload } from '@/types/document'

/** Markdown 文档组件：渲染富文本，并把文章内的相对路径配图解析为产物地址 */
const props = defineProps<{ payload: DocumentPayload }>()

/** HTML 属性转义（marked 原样输出地址，映射后需自行转义） */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 配图需带鉴权拉取字节（<img> 无法携带 Authorization），统一换成 blob 地址 */
const images = useArtifactImages(
  () => props.payload.text || '',
  () => ({
    threadId: props.payload.threadId,
    basePath: props.payload.basePath,
    artifactPaths: props.payload.artifactPaths,
  }),
)

const html = computed(() => {
  const text = props.payload.text || ''
  const imageMap = buildImageSrcMap(text, {
    threadId: props.payload.threadId,
    basePath: props.payload.basePath,
    artifactPaths: props.payload.artifactPaths,
  })
  const renderer = new marked.Renderer()
  renderer.image = ({ href, title, text: alt }) => {
    const raw = href ?? ''
    const src = images.renderSrc(raw, imageMap)
    const attrs = ['src="' + escapeAttr(src) + '"', 'alt="' + escapeAttr(alt ?? '') + '"']
    if (title) attrs.push('title="' + escapeAttr(title) + '"')
    return '<img ' + attrs.join(' ') + '>'
  }
  return marked.parse(text, { breaks: true, renderer })
})
</script>

<template>
  <div class="markdown-viewer" v-html="html"></div>
</template>

<style scoped>
.markdown-viewer {
  font-size: var(--font-size-md);
  line-height: 1.7;
  color: var(--foreground-primary);
  word-break: break-word;
}

.markdown-viewer :deep(h1),
.markdown-viewer :deep(h2),
.markdown-viewer :deep(h3),
.markdown-viewer :deep(h4) {
  margin: 14px 0 8px;
  font-weight: var(--font-weight-semibold);
}

.markdown-viewer :deep(h1) {
  font-size: 20px;
}

.markdown-viewer :deep(h2) {
  font-size: 17px;
}

.markdown-viewer :deep(h3) {
  font-size: 15px;
}

.markdown-viewer :deep(p) {
  margin: 8px 0;
}

.markdown-viewer :deep(ul),
.markdown-viewer :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}

.markdown-viewer :deep(code) {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.markdown-viewer :deep(pre) {
  margin: 10px 0;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  overflow-x: auto;
}

.markdown-viewer :deep(pre code) {
  padding: 0;
  background: none;
}

.markdown-viewer :deep(blockquote) {
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--accent-primary);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.markdown-viewer :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  width: 100%;
}

.markdown-viewer :deep(th),
.markdown-viewer :deep(td) {
  border: 1px solid var(--border-medium);
  padding: 6px 10px;
  text-align: left;
}

.markdown-viewer :deep(th) {
  background: var(--surface-secondary);
  font-weight: var(--font-weight-semibold);
}

.markdown-viewer :deep(img) {
  max-width: 100%;
  height: auto;
}

.markdown-viewer :deep(a) {
  color: var(--accent-primary);
  text-decoration: none;
}

.markdown-viewer :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 12px 0;
}
</style>
