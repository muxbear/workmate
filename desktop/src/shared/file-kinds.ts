/**
 * 附件文件类型分类：主进程与渲染层共用，避免前后端白名单漂移。
 *
 * 注意：该模块会被 main 与 renderer 同时引用，只能保留纯 TypeScript 逻辑，
 * 不要引入 fs/path 等 Node 专用依赖。
 */

export const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'csv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'go',
  'rs',
  'sh',
  'sql',
  'log',
  'ini',
  'toml'
] as const

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] as const

/** 转换型文档：复用 FileLoaders 的专用文本提取器。 */
export const DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'pptx'] as const

export type FileKind = 'text' | 'image' | 'pdf' | 'document' | 'unsupported'

/** 单次最多附件数。 */
export const MAX_ATTACH_FILES = 10
/** 文本文件原始字节上限。 */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024
/** 图片原始字节上限（DeepSeek 视觉接口 base64 惯例上限）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** PDF 原始字节上限（对齐 FileLoaders.MAX_BINARY_BYTES）。 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
/** 转换型文档原始字节上限（对齐 FileLoaders.MAX_BINARY_BYTES）。 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
/** 附件文本送入模型的字符上限（控制上下文预算）。 */
export const MAX_ATTACH_TEXT_CHARS = 50 * 1024

/** 取文件名；兼容 Windows 与 POSIX 路径分隔符。 */
export function getFileName(path: string): string {
  const winSep = String.fromCharCode(92)
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf(winSep))
  return path.slice(slash + 1) || path
}

/** 取扩展名（小写、无点）。 */
export function getFileExt(path: string): string {
  const name = getFileName(path)
  if (!name.includes('.')) return ''
  return name.split('.').pop()?.toLowerCase() ?? ''
}

/** 按扩展名分类文件类型。 */
export function classifyExtension(ext: string): FileKind {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  if ((TEXT_EXTENSIONS as readonly string[]).includes(normalized)) return 'text'
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(normalized)) return 'image'
  if ((DOCUMENT_EXTENSIONS as readonly string[]).includes(normalized)) return 'document'
  if (normalized === 'pdf') return 'pdf'
  return 'unsupported'
}

/** 按路径分类文件类型。 */
export function classifyPath(path: string): FileKind {
  return classifyExtension(getFileExt(path))
}

/** 返回指定类型的原始字节上限；unsupported/missing 返回 0。 */
export function limitForKind(kind: FileKind | 'missing'): number {
  if (kind === 'text') return MAX_TEXT_FILE_BYTES
  if (kind === 'image') return MAX_IMAGE_BYTES
  if (kind === 'pdf') return MAX_PDF_BYTES
  if (kind === 'document') return MAX_DOCUMENT_BYTES
  return 0
}
