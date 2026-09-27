import { marked } from 'marked'

/**
 * 先转义 HTML 实体，再交给 marked 解析。
 *
 * 问答面板会把**检索到的文档正文**拼进提示词，也就是说回答里可能夹带上传文档里的
 * 任意字符；直接 `v-html` 一段模型输出等于把那条链路重新打开。本模块同一目录下的
 * `KbDocDetailDrawer` 已经因为同样的问题中过一次招（见那里的 XSS 注释），所以这里
 * 不复用 `MessageItem` 的裸 `marked.parse`。
 *
 * 做法是**在解析前**把 `& < > " '` 转义掉：markdown 的语法（标题、列表、加粗、
 * 代码块）本身不依赖这些字符，格式化能力全部保留，而 HTML 标签只会以字面量出现。
 */
export function renderSafeMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
  return marked.parse(escaped, { breaks: true }) as string
}
