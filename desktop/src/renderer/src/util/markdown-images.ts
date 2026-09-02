/** 匹配 Markdown 图片语法中的 http(s) 链接：![alt](url) */
const MARKDOWN_IMAGE_URL_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g

/** 匹配 HTML <img src="http(s)...">（兜底 html 内容类型） */
const HTML_IMAGE_URL_RE = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/g

/**
 * 提取文本中的远程图片 URL（去重、保序）。
 * 用于渲染前把外链解析为本地 ke-img:// 地址，规避渲染层 CSP 对 http(s) 图片的拦截。
 */
export function extractRemoteImageUrls(content: string): string[] {
  const urls = new Set<string>()
  for (const match of content.matchAll(MARKDOWN_IMAGE_URL_RE)) {
    urls.add(match[1])
  }
  for (const match of content.matchAll(HTML_IMAGE_URL_RE)) {
    urls.add(match[1])
  }
  return [...urls]
}

/** 匹配 Markdown 图片语法中的相对路径引用（供工作区本地图片渲染使用） */
const WORKSPACE_IMAGE_PATH_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

/** 判断字符串是否为协议地址（http/data/blob/file 等） */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 归一化工作区相对图片路径：去掉 ./ 前缀与锚点/查询参数 */
export function normalizeWorkspaceImagePath(raw: string): string {
  const path = raw.split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\/+/, '')
  return path
}

function isWorkspaceRelativePath(raw: string): boolean {
  const value = raw.trim()
  if (SCHEME_RE.test(value) || value.startsWith('/')) return false
  return true
}

/** 提取文本中的工作区相对图片路径（去重、保序），供渲染前读取工作区图片 */
export function extractWorkspaceImagePaths(content: string): string[] {
  const paths = new Set<string>()
  for (const match of content.matchAll(WORKSPACE_IMAGE_PATH_RE)) {
    if (isWorkspaceRelativePath(match[1])) paths.add(normalizeWorkspaceImagePath(match[1]))
  }
  return [...paths]
}
