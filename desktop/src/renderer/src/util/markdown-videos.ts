/**
 * Markdown 正文中 HTML5 视频的工作区相对路径提取与替换工具。
 *
 * 「视频创作专家」把成片保存到与文档同名的目录，并在 Markdown 中用
 * `<video controls src=同名目录/成片-1.mp4>` 或
 * `<video controls><source src=同名目录/成片-1.mp4></video>` 两种写法引用本地文件；
 * 渲染前需要把这两类相对路径都经主进程读为 blob 地址，才能在页面内播放/暂停。
 */

/** 匹配整段视频块：`<video …>…</video>`，无闭合标签时退化为只匹配起始标签 */
const HTML_VIDEO_BLOCK_RE = /<video\b[^>]*>(?:[\s\S]*?<\/video>)?/gi

/** 匹配标签内的 src 属性（`<video src=…>` 与 `<source src=…>` 都覆盖） */
const SRC_ATTR_RE = /\bsrc\s*=\s*(['"])([^'"]+)\1/gi

/** 判断字符串是否为协议地址（http/data/blob/file 等） */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 归一化工作区相对视频路径：去掉 ./ 前缀与锚点/查询参数 */
export function normalizeWorkspaceVideoPath(raw: string): string {
  return raw.split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\/+/, '')
}

function isWorkspaceRelativePath(raw: string): boolean {
  const value = raw.trim()
  if (SCHEME_RE.test(value) || value.startsWith('/')) return false
  return true
}

/** 提取单段视频块中的工作区相对路径（含 `<source>` 子标签） */
function collectBlockPaths(block: string, out: Set<string>): void {
  for (const match of block.matchAll(SRC_ATTR_RE)) {
    const raw = match[2]
    if (isWorkspaceRelativePath(raw)) out.add(normalizeWorkspaceVideoPath(raw))
  }
}

/** 提取正文中视频的工作区相对路径（去重、保序），供渲染前读取工作区视频 */
export function extractWorkspaceVideoPaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(HTML_VIDEO_BLOCK_RE)) {
    collectBlockPaths(match[0], paths)
  }
  return [...paths]
}

/**
 * 把渲染后 HTML 中视频的相对 src 替换为 blob 地址。
 *
 * 同时覆盖 `<video src=…>` 与 `<video><source src=…></video>` 两种写法；
 * 仅替换已成功解析（map 中存在）的路径，其余保持原样避免破坏外链/网络地址。
 */
export function replaceWorkspaceVideoSrc(html: string, map: Record<string, string>): string {
  if (!html) return html
  return html.replace(HTML_VIDEO_BLOCK_RE, (block) =>
    block.replace(SRC_ATTR_RE, (attr, quote: string, raw: string) => {
      const normalized = normalizeWorkspaceVideoPath(raw)
      const url = map[normalized] ?? map[raw]
      return url ? 'src=' + quote + url + quote : attr
    })
  )
}
