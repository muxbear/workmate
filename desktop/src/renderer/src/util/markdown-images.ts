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
