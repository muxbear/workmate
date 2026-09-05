<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { marked } from 'marked'
import {
  extractRemoteImageUrls,
  extractWorkspaceImagePaths,
  normalizeWorkspaceImagePath
} from '../util/markdown-images'
import { isDocRelPath, normalizeWorkspaceDocPath } from '../util/doc-files'

/**
 * 消息内容渲染组件
 *
 * 支持多种内容类型的渲染，为未来格式扩展留出接口。
 *
 * 扩展方式：新增 contentType 值，添加对应的渲染逻辑分支。
 * 未来可重构为 plugin 注册模式：
 *   const renderers: Record<string, ContentRenderer> = { ... }
 */

export interface MessageContentProps {
  content: string
  contentType?: 'markdown' | 'text' | 'html'
  /** 会话绑定的工作空间 id；存在时把正文中的工作区相对图片读取为可显示地址 */
  workspaceId?: string
}

const props = withDefaults(defineProps<MessageContentProps>(), {
  contentType: 'markdown',
  workspaceId: undefined
})

/** 工作区文档链接点击 → 由父级在右侧栏打开（历史与实时共用同一渲染路径） */
const emit = defineEmits<{ (e: 'open-file', relPath: string): void }>()

function onContentClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const link = target?.closest<HTMLElement>('[data-open-file]')
  if (!link) return
  event.preventDefault()
  const relPath = link.getAttribute('data-open-file')
  if (relPath) emit('open-file', relPath)
}

/** 原始图片 URL → 本地 ke-img:// 地址（主进程 images:resolve 解析结果） */
const imageSrcMap = ref<Record<string, string>>({})
const resolvingUrls = new Set<string>()

/** 内容中出现的远程图片 URL（仅 http(s) 外链） */
const remoteImageUrls = computed(() => extractRemoteImageUrls(props.content))

/** 工作区相对图片路径 → blob 地址 */
const workspaceImageMap = ref<Record<string, string>>({})
const resolvingWorkspacePaths = new Set<string>()
const workspaceImagePaths = computed(() =>
  props.workspaceId ? extractWorkspaceImagePaths(props.content) : []
)

function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'svg':
      return 'image/svg+xml'
    case 'ico':
      return 'image/x-icon'
    default:
      return 'application/octet-stream'
  }
}

let workspaceEpoch = 0

function revokeWorkspaceBlobs(): void {
  for (const url of Object.values(workspaceImageMap.value)) URL.revokeObjectURL(url)
  workspaceImageMap.value = {}
  resolvingWorkspacePaths.clear()
}

// 内容变化时逐批解析远程图片；解析完成后重渲染，<img> 指向 CSP 放行的本地缓存地址
watch(
  remoteImageUrls,
  (urls) => {
    for (const url of urls) {
      if (imageSrcMap.value[url] || resolvingUrls.has(url)) continue
      resolvingUrls.add(url)
      window.api
        .resolveRemoteImage(url)
        .then((res) => {
          if (res.success && res.data?.url) {
            imageSrcMap.value = { ...imageSrcMap.value, [url]: res.data.url }
          }
        })
        .catch(() => {
          // 解析失败保持原 URL（受 CSP 拦截显示裂图，但不影响整篇渲染）
        })
        .finally(() => {
          resolvingUrls.delete(url)
        })
    }
  },
  { immediate: true }
)

// 内容含工作区相对图片时：逐批从工作区读取字节并生成 blob 地址（仅展示层替换，不改写消息原文）
watch(
  [workspaceImagePaths, () => props.workspaceId],
  ([paths, workspaceId]) => {
    if (!workspaceId) return
    const epoch = workspaceEpoch
    for (const relPath of paths) {
      if (workspaceImageMap.value[relPath] || resolvingWorkspacePaths.has(relPath)) continue
      resolvingWorkspacePaths.add(relPath)
      window.api
        .readWorkspaceImageBytes(workspaceId, relPath)
        .then((res) => {
          if (!res.success || !res.data) return
          const rawBuffer = res.data.bytes.buffer.slice(
            res.data.bytes.byteOffset,
            res.data.bytes.byteOffset + res.data.bytes.byteLength
          ) as ArrayBuffer
          const blob = new Blob([rawBuffer], { type: mimeForImageExt(res.data.ext) })
          const url = URL.createObjectURL(blob)
          if (epoch !== workspaceEpoch) {
            URL.revokeObjectURL(url)
            return
          }
          workspaceImageMap.value = { ...workspaceImageMap.value, [relPath]: url }
        })
        .catch(() => {
          // 读取失败保持原相对路径（裂图但不影响消息渲染）
        })
        .finally(() => {
          resolvingWorkspacePaths.delete(relPath)
        })
    }
  },
  { immediate: true }
)

// 切换会话/工作空间时回收旧 blob，避免泄漏
watch(
  () => props.workspaceId,
  () => {
    workspaceEpoch += 1
    revokeWorkspaceBlobs()
  }
)
onBeforeUnmount(revokeWorkspaceBlobs)

/** HTML 属性转义（marked 输出原样携带 URL，映射后需自行转义） */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const renderedHtml = computed(() => {
  if (!props.content) return ''

  switch (props.contentType) {
    case 'markdown': {
      // 自定义 image renderer：外链替换为 ke-img://；工作区相对路径替换为 blob 地址
      const renderer = new marked.Renderer()
      // 工作区相对文档链接（md/docx/html/txt/json 等白名单）→ 可点击并在右侧栏打开
      renderer.link = ({ href, title, text }) => {
        const raw = href ?? ''
        const isExternal = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('#')
        const normalized = normalizeWorkspaceDocPath(raw)
        const q = String.fromCharCode(34)
        if (!isExternal && normalized && isDocRelPath(normalized)) {
          const titleAttr = title ? ' title=' + q + escapeHtmlAttr(title) + q : ''
          return (
            '<a href=' +
            q +
            '#' +
            q +
            ' data-open-file=' +
            q +
            escapeHtmlAttr(normalized) +
            q +
            titleAttr +
            '>' +
            text +
            '</a>'
          )
        }
        const hrefAttr = escapeHtmlAttr(raw)
        const titleAttr2 = title ? ' title=' + q + escapeHtmlAttr(title) + q : ''
        return '<a href=' + q + hrefAttr + q + titleAttr2 + '>' + text + '</a>'
      }
      renderer.image = ({ href, title, text }) => {
        const normalized = normalizeWorkspaceImagePath(href)
        const src =
          imageSrcMap.value[href] ??
          workspaceImageMap.value[normalized] ??
          workspaceImageMap.value[href] ??
          href
        const attrs = [`src="${escapeHtmlAttr(src)}"`, `alt="${escapeHtmlAttr(text)}"`]
        if (title) attrs.push(`title="${escapeHtmlAttr(title)}"`)
        return `<img ${attrs.join(' ')}>`
      }
      return marked.parse(props.content, { async: false, renderer }) as string
    }
    case 'html':
      // 预留：未来可在此处添加 XSS 过滤（如 DOMPurify.sanitize）
      return props.content
    case 'text':
    default:
      // 纯文本：转义 HTML 并保留换行
      return props.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
  }
})
</script>

<template>
  <div
    v-if="contentType === 'markdown' || contentType === 'html'"
    class="message-content message-content--rich"
    v-html="renderedHtml"
    @click="onContentClick"
  ></div>
  <div
    v-else
    class="message-content message-content--text"
    v-html="renderedHtml"
    @click="onContentClick"
  ></div>
</template>

<style>
/* ═══════════════════════════════════════════════════════════════════════════
   Markdown Content Styles (unscoped — applies to v-html rendered content)
   ═══════════════════════════════════════════════════════════════════════════ */
.message-content--rich {
  line-height: 1.7;
  word-break: break-word;
}

.message-content--rich h1,
.message-content--rich h2,
.message-content--rich h3,
.message-content--rich h4,
.message-content--rich h5,
.message-content--rich h6 {
  margin: 16px 0 8px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--kw-color-text);
}

.message-content--rich h1 {
  font-size: 1.4em;
}
.message-content--rich h2 {
  font-size: 1.25em;
}
.message-content--rich h3 {
  font-size: 1.1em;
}

.message-content--rich p {
  margin: 8px 0;
}

.message-content--rich p:first-child {
  margin-top: 0;
}

.message-content--rich p:last-child {
  margin-bottom: 0;
}

.message-content--rich ul,
.message-content--rich ol {
  margin: 8px 0;
  padding-left: 20px;
}

.message-content--rich li {
  margin: 4px 0;
}

.message-content--rich code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
  font-size: 0.9em;
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
}

.message-content--rich pre {
  margin: 12px 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: #1a2332;
  overflow-x: auto;
}

.message-content--rich pre code {
  padding: 0;
  background: transparent;
  color: #e2e8f0;
  font-size: 0.85em;
  line-height: 1.6;
}

.message-content--rich blockquote {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 3px solid #0891b2;
  background: var(--kw-color-brand-hover);
  border-radius: 0 8px 8px 0;
  color: var(--kw-color-text-secondary);
}

.message-content--rich table {
  margin: 12px 0;
  border-collapse: collapse;
  width: 100%;
  font-size: 0.9em;
}

.message-content--rich th,
.message-content--rich td {
  padding: 8px 12px;
  border: 1px solid var(--kw-color-border-brand);
  text-align: left;
}

.message-content--rich th {
  background: var(--kw-color-brand-hover);
  font-weight: 600;
  color: var(--kw-color-text);
}

.message-content--rich td {
  color: var(--kw-color-text-secondary);
}

.message-content--rich a {
  color: var(--kw-color-brand);
  text-decoration: none;
}

.message-content--rich a:hover {
  text-decoration: underline;
}

.message-content--rich strong {
  font-weight: 600;
  color: var(--kw-color-text);
}

.message-content--rich hr {
  margin: 16px 0;
  border: none;
  border-top: 1px solid var(--kw-color-border-brand);
}

.message-content--rich img {
  max-width: 100%;
  border-radius: 8px;
}

/* Plain text mode */
.message-content--text {
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
