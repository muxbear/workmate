import {
  normalizeImagePath,
  resolveArtifactImage,
  type MarkdownImageContext,
} from '@/utils/markdownArtifacts'

/**
 * Markdown 正文中 HTML5 `<video>` 标签的产物地址解析。
 *
 * 「视频创作专家」把成片放在与文档同名的目录中，并在文档里以
 * `<video controls src="视频标题/成片-1.mp4"></video>` 引用。marked 会把 HTML
 * 标签原样透传，浏览器按站点相对地址请求 → 404；即便拿到正确地址，产物接口
 * 需要 Bearer 鉴权而 `<video>` 无法携带 Authorization（与 `<img>` 同理）。
 *
 * 因此这里只做两件事：把相对 `src` 解析为产物虚拟路径；在渲染后的 HTML 上把
 * `src` 替换为已就绪的 blob 地址（加载中的先摘掉 src，避免打出 404 请求）。
 * 路径解析规则与配图完全一致（复用 `markdownArtifacts` 的归一化与越界校验）。
 */

/** 匹配整段视频块：`<video …>…</video>`；无闭合标签时退化为只匹配起始标签 */
const VIDEO_BLOCK_RE = /<video\b[^>]*>(?:[\s\S]*?<\/video>)?/gi

/** 匹配标签内的 `src="..."`（覆盖 `<video src=…>` 与内嵌 `<source src=…>`） */
const SRC_ATTR_RE = /\bsrc\s*=\s*(['"])([^'"]+)\1/gi

/** 判断是否为协议地址（http/data/blob/file 等）；这类地址由浏览器自行加载 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 提取正文中视频的相对路径（含内嵌 `<source src>`；去重保序，跳过协议地址） */
export function extractVideoSources(content: string): string[] {
  const found = new Set<string>()
  for (const block of String(content ?? '').matchAll(VIDEO_BLOCK_RE)) {
    for (const attr of block[0].matchAll(SRC_ATTR_RE)) {
      const trimmed = (attr[2] ?? '').trim()
      if (!trimmed || SCHEME_RE.test(trimmed)) continue
      found.add(trimmed)
    }
  }
  return [...found]
}

/**
 * 生成「原始 src → 产物虚拟路径」的解析结果，供加载器使用。
 *
 * 未命中产物清单（或非产物地址）的 src 不会出现在结果中。
 */
export function resolveVideoArtifacts(
  content: string,
  context: MarkdownImageContext,
): Record<string, { threadId: string; path: string }> {
  const out: Record<string, { threadId: string; path: string }> = {}
  for (const src of extractVideoSources(content)) {
    const target = resolveArtifactImage(src, context)
    if (target) out[src] = target
  }
  return out
}

/**
 * 把渲染后 HTML 中视频的相对 src 替换为已就绪的 blob 地址。
 *
 * 同时覆盖 `<video src=…>` 与 `<video><source src=…></video>` 两种写法
 * （后者是模型常用的 HTML5 写法）。加载中或超出内联上限的地址会把 `src`
 * 摘成 `data-artifact-src`，避免浏览器去请求不存在的相对地址。
 *
 * @param html 渲染后的 HTML
 * @param map 原始 src → blob 地址（仅包含已就绪项）
 * @param deferred 暂不内联的原始 src（加载中 / 超出上限）
 */
export function replaceVideoSrc(
  html: string,
  map: Record<string, string>,
  deferred: Record<string, true> = {},
): string {
  if (!html) return html
  return html.replace(VIDEO_BLOCK_RE, (block) => {
    let deferredUsed = block.includes('data-artifact-src')
    return block.replace(SRC_ATTR_RE, (attr, quote: string, raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed || SCHEME_RE.test(trimmed)) return attr

      const ready = map[trimmed] ?? map[normalizeImagePath(trimmed)]
      if (ready) return 'src=' + quote + ready + quote
      if (deferred[trimmed] && !deferredUsed) {
        // 同段视频只保留一个占位标记，避免同一标签上出现重复的属性名
        deferredUsed = true
        return 'data-artifact-src=' + quote + raw + quote
      }
      if (deferred[trimmed]) return ''
      return attr
    })
  })
}
