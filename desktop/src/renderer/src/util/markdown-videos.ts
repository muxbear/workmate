/**
 * Markdown 正文中 HTML5 <video> 标签的工作区相对路径提取与替换工具。
 *
 * 「视频创作专家」把成片保存到与文档同名的目录，并在 Markdown 中用
 * <video controls src=同名目录/成片-1.mp4> 引用本地文件；渲染前需要把
 * 这类相对路径经主进程读为 blob 地址，才能在页面内播放/暂停。
 */

/** 匹配 HTML <video ... src=相对路径>（支持单双引号，属性顺序不限） */
const HTML_VIDEO_SRC_RE = /<video\b[^>]*?\bsrc\s*=\s*(['\u0022])([^'\u0022]+)\1[^>]*>/gi

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

/** 提取正文中 <video src> 的工作区相对路径（去重、保序），供渲染前读取工作区视频 */
export function extractWorkspaceVideoPaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(HTML_VIDEO_SRC_RE)) {
    const raw = match[2]
    if (isWorkspaceRelativePath(raw)) paths.add(normalizeWorkspaceVideoPath(raw))
  }
  return [...paths]
}

/**
 * 把渲染后 HTML 中 <video> 的相对 src 替换为 blob 地址。
 * 仅替换已成功解析（map 中存在）的路径；其余保持原样避免破坏外链/网络地址。
 */
export function replaceWorkspaceVideoSrc(html: string, map: Record<string, string>): string {
  if (!html) return html
  return html.replace(/<video\b[^>]*>/gi, (tag) => {
    return tag.replace(
      /\bsrc\s*=\s*(['\u0022])([^'\u0022]+)\1/gi,
      (srcAttr, quote, raw: string) => {
        const normalized = normalizeWorkspaceVideoPath(raw)
        const url = map[normalized] ?? map[raw]
        return url ? 'src=' + quote + url + quote : srcAttr
      }
    )
  })
}
