import type { DocumentKind, DocumentTypeInfo } from '@/types/document'

/** 扩展名 → 文档类型 */
const EXT_KIND: Record<string, DocumentKind> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  json: 'json',
  csv: 'table',
  tsv: 'table',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  xls: 'excel',
  xlsx: 'excel',
  ods: 'excel',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  odp: 'powerpoint',
  txt: 'text',
  log: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  ini: 'text',
  toml: 'text',
  py: 'text',
  js: 'text',
  ts: 'text',
  tsx: 'text',
  jsx: 'text',
  vue: 'text',
  java: 'text',
  go: 'text',
  rs: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  sh: 'text',
  sql: 'text',
  css: 'text',
}

/** 文档类型 → 中文名称 */
const KIND_LABEL: Record<DocumentKind, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  json: 'JSON',
  image: '图片',
  video: '视频',
  pdf: 'PDF',
  table: '表格',
  text: '文本',
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PPT',
  binary: '文件',
}

/** 按文本读取的文档类型 */
const TEXT_KINDS: DocumentKind[] = ['markdown', 'html', 'json', 'table', 'text']

/** 已提供文档组件的类型；Word / Excel / PPT 需要服务端解析，组件规划中 */
const READY_KINDS: DocumentKind[] = [
  'markdown',
  'html',
  'json',
  'table',
  'text',
  'image',
  'video',
  'pdf',
]

/** 取文件名小写扩展名（无扩展名返回空串） */
export function fileExtension(name: string): string {
  const dot = (name || '').lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

function kindFromExtension(name: string): DocumentKind | null {
  const ext = fileExtension(name)
  if (!ext) return null
  return EXT_KIND[ext] ?? null
}

function kindFromMime(mimeType: string): DocumentKind {
  const mime = (mimeType || '').toLowerCase()
  if (!mime) return 'binary'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.includes('json')) return 'json'
  if (mime.includes('html')) return 'html'
  if (mime.includes('markdown')) return 'markdown'
  if (mime.includes('csv') || mime.includes('tab-separated')) return 'table'
  if (mime.includes('word') || mime.includes('opendocument.text')) return 'word'
  if (mime.includes('spreadsheet') || mime.includes('excel')) return 'excel'
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'powerpoint'
  if (mime.startsWith('text/')) return 'text'
  return 'binary'
}

/** 解析文档类型：优先按扩展名，其次按 MIME，最后回退为通用二进制 */
export function resolveDocumentType(name: string, mimeType = ''): DocumentTypeInfo {
  const kind = kindFromExtension(name) ?? kindFromMime(mimeType)
  return {
    kind,
    label: KIND_LABEL[kind],
    text: TEXT_KINDS.includes(kind),
    ready: READY_KINDS.includes(kind),
  }
}
