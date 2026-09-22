import { artifactDownloadUrl } from '@/services/request'

/**
 * Markdown 图片引用的产物地址解析。
 *
 * 「文档写作专家」把文章与配图放在同一交付目录中，文章内以相对路径引用配图
 * （如 `![](文章标题/figure-1.png)`）。浏览器无法解析这种相对路径，渲染前需要
 * 把它们映射到后端产物地址：相对路径 → 交付目录虚拟路径 → 产物下载接口。
 */

/** 协议地址（http/data/blob/file 等）原样保留 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 匹配 Markdown 图片语法 ![alt](src) */
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

export interface MarkdownImageContext {
  /** 当前会话 id；缺省时不替换 */
  threadId?: string | null
  /** 当前文档的虚拟路径（如 /artifacts/<thread>/turn-1/文章.md） */
  basePath?: string | null
  /** 会话产物虚拟路径集合；提供且非空时按"命中才替换"处理 */
  artifactPaths?: string[]
  /**
   * 产物接口基址（如 `https://host/api`）。
   * 缺省沿用 request.ts 的 VITE_API_BASE_URL / `/api`；
   * 显式传入便于与其它端（移动端 ArkTS 实现）保持同规则。
   */
  apiBaseUrl?: string
}

/** 拼接产物预览/下载地址：显式基址优先，否则走 artifactDownloadUrl 的环境变量基址 */
function buildDownloadUrl(
  context: MarkdownImageContext,
  threadId: string,
  path: string,
): string {
  const base = context.apiBaseUrl?.trim()
  if (!base) return artifactDownloadUrl(threadId, path, 'inline')

  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return (
    normalized +
    '/chat/artifacts/' +
    encodeURIComponent(threadId) +
    '/download?disposition=inline&path=' +
    encodeURIComponent(path)
  )
}

/** 归一化图片路径：解码百分号编码、统一斜杠、去掉查询串与锚点 */
export function normalizeImagePath(raw: string): string {
  let value = String(raw ?? '').trim()
  try {
    value = decodeURIComponent(value)
  } catch {
    // 编码非法时保留原值
  }
  return value.replace(/\\/g, '/').split('#')[0].split('?')[0]
}

/**
 * 以 basePath 所在目录为基准解析相对路径。
 *
 * 返回以 `/` 开头的虚拟绝对路径；协议地址或越出根目录时返回空串。
 */
export function resolveImagePath(basePath: string | null | undefined, rawPath: string): string {
  const rel = normalizeImagePath(rawPath)
  if (!rel || SCHEME_RE.test(rel)) return ''
  if (rel.startsWith('/')) {
    const parts = rel.split('/').filter((part) => part && part !== '.')
    return parts.length ? '/' + parts.join('/') : ''
  }

  const base = normalizeImagePath(basePath ?? '')
  const slash = base.lastIndexOf('/')
  const dir = slash >= 0 ? base.slice(0, slash) : ''
  const segments = [...(dir ? dir.split('/') : []), ...rel.split('/')]
  const out: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!out.length) return ''
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length ? '/' + out.join('/') : ''
}

/** 配图解析结果：命中的产物所属会话与虚拟路径 */
export interface ResolvedArtifactImage {
  threadId: string
  path: string
}

/**
 * 把单个图片地址解析为「产物所属会话 + 虚拟路径」。
 *
 * 与 {@link resolveImageSrc} 同规则，但返回路径而非下载地址：需要带鉴权拉取
 * 字节再渲染的调用方（浏览器 <img> 无法携带 Authorization 头）用它拿到目标。
 * 非产物图片（协议地址、缺省会话、未命中产物清单）返回 null。
 */
export function resolveArtifactImage(
  rawSrc: string,
  context: MarkdownImageContext,
): ResolvedArtifactImage | null {
  const threadId = context.threadId
  if (!threadId) return null

  const trimmed = String(rawSrc ?? '').trim()
  if (!trimmed || SCHEME_RE.test(trimmed)) return null

  const resolved = resolveImagePath(context.basePath, trimmed)
  if (!resolved) return null

  const candidates = [resolved]
  const normalizedRaw = normalizeImagePath(trimmed)
  if (normalizedRaw.startsWith('/') && normalizedRaw !== resolved) candidates.push(normalizedRaw)

  const known = context.artifactPaths
  if (known && known.length > 0) {
    const hit = candidates.find((candidate) => known.includes(candidate))
    return hit ? { threadId, path: hit } : null
  }
  return { threadId, path: resolved }
}

/** 把单个图片地址解析为可访问地址；无需替换时返回原值 */
export function resolveImageSrc(rawSrc: string, context: MarkdownImageContext): string {
  const target = resolveArtifactImage(rawSrc, context)
  if (!target) return rawSrc
  return buildDownloadUrl(context, target.threadId, target.path)
}

/** 提取 Markdown 中出现的图片地址（去重保序） */
export function extractImageSources(markdown: string): string[] {
  const found = new Set<string>()
  for (const match of String(markdown ?? '').matchAll(IMAGE_RE)) {
    const src = match[1]
    if (src) found.add(src)
  }
  return [...found]
}

/** 生成「原始地址 → 可访问地址」映射，供 marked renderer 使用 */
export function buildImageSrcMap(
  markdown: string,
  context: MarkdownImageContext,
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const src of extractImageSources(markdown)) {
    const resolved = resolveImageSrc(src, context)
    if (resolved !== src) map[src] = resolved
  }
  return map
}
