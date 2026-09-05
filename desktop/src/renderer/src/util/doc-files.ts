/** 消息正文中可点击打开到右侧栏的文档扩展名白名单（与主进程 doc-artifacts 保持一致） */
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'html',
  'htm',
  'txt',
  'json',
  'csv',
  'yaml',
  'yml',
  'xml',
  'doc',
  'docx',
  'pdf'
])

/** 归一化消息正文中的工作区相对文档路径（去 ./ 与 / 前缀、锚点查询参数） */
export function normalizeWorkspaceDocPath(raw: string): string {
  const value = raw.split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\/+/, '')
  return value
}

export function extOfDocPath(relPath: string): string {
  const parts = relPath.split('.')
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : ''
}

export function isDocRelPath(relPath: string): boolean {
  const ext = extOfDocPath(relPath)
  return DOC_EXTENSIONS.has(ext)
}
