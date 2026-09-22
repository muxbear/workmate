/**
 * 文章配图解析与产物地址构建。
 *
 * 与 Web 前端 web/frontend/src/utils/markdownArtifacts.ts 同规则:
 * 文章内的配图是相对路径(![](文章标题/figure-1.png)),需要先解析成交付目录虚拟路径,
 * 再映射到后端产物接口;移动端必须带 token 拉取字节后渲染,不能直接交给 Image 组件。
 */

/** 协议地址(http/data/blob/file 等)原样保留 */
const SCHEME_RE: RegExp = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 默认接口前缀(与 Web 前端 VITE_API_BASE_URL 默认值一致) */
const DEFAULT_API_BASE: string = '/api'

/** 配图解析上下文 */
export interface MarkdownImageContext {
  /** 当前会话 id;缺省时不替换 */
  threadId?: string
  /** 当前文档的虚拟路径(相对图片以其所在目录为基准) */
  basePath?: string
  /** 会话产物虚拟路径集合;提供且非空时按"命中才替换"处理 */
  artifactPaths?: Array<string>
  /** 产物接口基址,如 https://host/api;缺省使用 /api */
  apiBaseUrl?: string
}

/** 是否包含目标字符串(ArkTS 用显式循环,避免依赖 includes 的兼容差异) */
function contains(list: Array<string>, target: string): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === target) {
      return true
    }
  }
  return false
}

/** 归一化图片路径:解码百分号编码、统一斜杠、去掉查询串与锚点 */
export function normalizeImagePath(raw: string): string {
  let value: string = raw.trim()
  try {
    value = decodeURIComponent(value)
  } catch (err) {
    // 编码非法时保留原值
  }
  const noHash: string = value.split('#')[0]
  return noHash.split('?')[0].replace(/\\/g, '/')
}

/** 逐段解析路径:处理 . 与 ..,越出根目录时返回空串 */
function resolveSegments(segments: Array<string>): string {
  const out: Array<string> = []
  for (let i = 0; i < segments.length; i++) {
    const segment: string = segments[i]
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (out.length === 0) {
        return ''
      }
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length === 0 ? '' : '/' + out.join('/')
}

/**
 * 以 basePath 所在目录为基准解析相对路径。
 *
 * 返回以 / 开头的虚拟绝对路径;协议地址或越出根目录时返回空串。
 */
export function resolveImagePath(basePath: string | undefined, rawPath: string): string {
  const rel: string = normalizeImagePath(rawPath)
  if (rel === '' || SCHEME_RE.test(rel)) {
    return ''
  }
  if (rel.startsWith('/')) {
    return resolveSegments(rel.split('/'))
  }
  const base: string = basePath === undefined ? '' : normalizeImagePath(basePath)
  const slash: number = base.lastIndexOf('/')
  const dir: string = slash >= 0 ? base.substring(0, slash) : ''
  const segments: Array<string> = []
  if (dir !== '') {
    const dirParts: Array<string> = dir.split('/')
    for (let i = 0; i < dirParts.length; i++) {
      segments.push(dirParts[i])
    }
  }
  const relParts: Array<string> = rel.split('/')
  for (let i = 0; i < relParts.length; i++) {
    segments.push(relParts[i])
  }
  return resolveSegments(segments)
}

/** 规范化接口基址(去尾部斜杠,空值回退 /api) */
function normalizeApiBase(apiBaseUrl: string | undefined): string {
  const raw: string = apiBaseUrl === undefined || apiBaseUrl.trim() === ''
    ? DEFAULT_API_BASE
    : apiBaseUrl.trim()
  return raw.endsWith('/') ? raw.substring(0, raw.length - 1) : raw
}

/** 产物预览/下载接口地址(需带 Authorization 头拉取,返回的是接口而非直链) */
export function buildArtifactDownloadUrl(
  apiBaseUrl: string | undefined,
  threadId: string,
  path: string,
  disposition: string
): string {
  return normalizeApiBase(apiBaseUrl)
    + '/chat/artifacts/' + encodeURIComponent(threadId)
    + '/download?disposition=' + disposition
    + '&path=' + encodeURIComponent(path)
}

/** 交付物打包接口地址(scope=turn 本轮 / scope=thread 整个会话) */
export function buildBundleUrl(
  apiBaseUrl: string | undefined,
  threadId: string,
  scope: string,
  turn?: string
): string {
  let url: string = normalizeApiBase(apiBaseUrl)
    + '/chat/artifacts/' + encodeURIComponent(threadId)
    + '/bundle.zip?scope=' + scope
  if (scope === 'turn' && turn !== undefined && turn !== '') {
    url += '&turn=' + encodeURIComponent(turn)
  }
  return url
}

/** 把单个图片地址解析为产物接口地址;无需替换时返回原值 */
export function resolveImageSrc(rawSrc: string, context: MarkdownImageContext): string {
  const threadId: string = context.threadId === undefined ? '' : context.threadId
  if (threadId === '') {
    return rawSrc
  }
  const trimmed: string = rawSrc.trim()
  if (trimmed === '' || SCHEME_RE.test(trimmed)) {
    return rawSrc
  }
  const resolved: string = resolveImagePath(context.basePath, trimmed)
  if (resolved === '') {
    return rawSrc
  }

  const candidates: Array<string> = [resolved]
  const normalizedRaw: string = normalizeImagePath(trimmed)
  if (normalizedRaw.startsWith('/') && normalizedRaw !== resolved) {
    candidates.push(normalizedRaw)
  }

  const known: Array<string> | undefined = context.artifactPaths
  let target: string = resolved
  if (known !== undefined && known.length > 0) {
    let hit: string = ''
    for (let i = 0; i < candidates.length; i++) {
      if (contains(known, candidates[i])) {
        hit = candidates[i]
        break
      }
    }
    if (hit === '') {
      return rawSrc
    }
    target = hit
  }
  return buildArtifactDownloadUrl(context.apiBaseUrl, threadId, target, 'inline')
}

/** 提取 Markdown 中出现的图片地址(去重保序) */
export function extractImageSources(markdown: string): Array<string> {
  const found: Array<string> = []
  const re: RegExp = /!\[[^\]]*\]\(([^)\s]+)\)/g
  let match: RegExpExecArray | null = re.exec(markdown)
  while (match !== null) {
    const src: string = match[1]
    if (src !== '' && !contains(found, src)) {
      found.push(src)
    }
    match = re.exec(markdown)
  }
  return found
}

/** 生成「原始地址 → 产物接口地址」映射,供 Markdown 渲染层替换 src */
export function buildImageSrcMap(
  markdown: string,
  context: MarkdownImageContext
): Map<string, string> {
  const map: Map<string, string> = new Map<string, string>()
  const sources: Array<string> = extractImageSources(markdown)
  for (let i = 0; i < sources.length; i++) {
    const src: string = sources[i]
    const resolved: string = resolveImageSrc(src, context)
    if (resolved !== src) {
      map.set(src, resolved)
    }
  }
  return map
}