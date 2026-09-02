<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import { extractRemoteImageUrls } from '../util/markdown-images'

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
}

const props = withDefaults(defineProps<MessageContentProps>(), {
  contentType: 'markdown'
})

/** 原始图片 URL → 本地 ke-img:// 地址（主进程 images:resolve 解析结果） */
const imageSrcMap = ref<Record<string, string>>({})
const resolvingUrls = new Set<string>()

/** 内容中出现的远程图片 URL（仅 http(s) 外链） */
const remoteImageUrls = computed(() => extractRemoteImageUrls(props.content))

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
      // 自定义 image renderer：外链替换为本地 ke-img:// 缓存地址
      const renderer = new marked.Renderer()
      renderer.image = ({ href, title, text }) => {
        const src = imageSrcMap.value[href] ?? href
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
  ></div>
  <div v-else class="message-content message-content--text" v-html="renderedHtml"></div>
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

.message-content--rich h1 { font-size: 1.4em; }
.message-content--rich h2 { font-size: 1.25em; }
.message-content--rich h3 { font-size: 1.1em; }

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
