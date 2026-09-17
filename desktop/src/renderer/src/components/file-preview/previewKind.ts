/**
 * 文件预览类型判定（纯函数）
 *
 * 知识库与工作空间共用同一套「按扩展名选渲染组件」的规则：
 * markdown → MessageContent；文本 → <pre>；图片 / PDF / Word → 各自组件；其余提示不支持。
 */

export type FilePreviewKind = 'markdown' | 'text' | 'image' | 'pdf' | 'word' | 'unsupported'

const MARKDOWN_EXTS = new Set(['md', 'markdown'])

const TEXT_EXTS = new Set([
  'txt',
  'csv',
  'tsv',
  'json',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'vue',
  'py',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bat',
  'ps1',
  'sql'
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'])
const PDF_EXTS = new Set(['pdf'])
const WORD_EXTS = new Set(['doc', 'docx'])

/** 取小写扩展名（不带点）；无扩展名返回空串 */
export function getFileExt(name: string): string {
  const index = String(name ?? '').lastIndexOf('.')
  if (index <= 0) return ''
  return name.slice(index + 1).toLowerCase()
}

/** 是否需要读取原始字节（图片 / PDF / Word） */
export function needsBytes(kind: FilePreviewKind): boolean {
  return kind === 'image' || kind === 'pdf' || kind === 'word'
}

/** 按文件名判定预览方式 */
export function pickPreviewKind(name: string): FilePreviewKind {
  const ext = getFileExt(name)
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (WORD_EXTS.has(ext)) return 'word'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'unsupported'
}

/** 不支持预览时的提示文案 */
export function unsupportedHint(name: string): string {
  const ext = getFileExt(name)
  return ext
    ? `暂不支持预览 .${ext} 格式，可在「查看详情」中查看元信息`
    : '暂不支持预览该文件类型，可在「查看详情」中查看元信息'
}
