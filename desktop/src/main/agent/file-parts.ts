import { readFile, stat } from 'fs/promises'
import { basename } from 'path'
import { loadFileText } from '../workspace/FileLoaders'
import type { MessagePart } from '../../preload/index.d'
import {
  MAX_ATTACH_FILES,
  MAX_ATTACH_TEXT_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_FILE_BYTES,
  classifyPath,
  getFileExt
} from '../../shared/file-kinds'

export {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_ATTACH_FILES,
  MAX_ATTACH_TEXT_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_FILE_BYTES,
  TEXT_EXTENSIONS,
  classifyExtension,
  classifyPath,
  getFileExt,
  limitForKind
} from '../../shared/file-kinds'
export type { FileKind } from '../../shared/file-kinds'

/** 换行符常量：避免在共享字符串中直接书写转义字符。 */
const LF = String.fromCharCode(10)

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}

/** 发送给模型的 LangChain 内容块（text / image_url）。 */
export type FileContentBlock =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/**
 * agent:send 入参形状校验（主进程权威；非法输入抛错，由 handler catch 返回错误）。
 * 限制：数组、text 为 string、file.path 为 string、文件数 <= MAX_ATTACH_FILES。
 */
export function validateMessageParts(input: unknown): MessagePart[] {
  if (!Array.isArray(input)) throw new Error('参数错误')
  const out: MessagePart[] = []
  let fileCount = 0
  for (const item of input) {
    if (typeof item !== 'object' || item === null) throw new Error('参数错误')
    const p = item as Record<string, unknown>
    if (p.type === 'text') {
      if (typeof p.text !== 'string') throw new Error('参数错误')
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'file') {
      if (typeof p.path !== 'string' || !p.path) throw new Error('参数错误')
      fileCount++
      if (fileCount > MAX_ATTACH_FILES) throw new Error('单次最多 ' + MAX_ATTACH_FILES + ' 个文件')
      out.push({ type: 'file', path: p.path })
    } else {
      throw new Error('参数错误')
    }
  }
  return out
}

/**
 * agent:send 入参归一（主进程权威）：字符串 -> 单文本段；数组 -> validateMessageParts。
 * 无有效内容（空数组 / 仅空文本段）抛「参数错误」。注意：仅含文件（无文本）是合法输入。
 */
export function normalizeMessageInput(content: unknown): MessagePart[] {
  const parts =
    typeof content === 'string'
      ? [{ type: 'text' as const, text: content }]
      : validateMessageParts(content)
  if (parts.length === 0 || parts.every((p) => p.type === 'text' && !p.text.trim())) {
    throw new Error('参数错误')
  }
  return parts
}

/** 文本内容截断到上下文预算，截断时追加标注。 */
function truncateForLLM(content: string, truncatedByLoader: boolean): string {
  const note = LF + '……（内容过长，已截断）'
  if (content.length <= MAX_ATTACH_TEXT_CHARS) {
    return truncatedByLoader ? content + note : content
  }
  return content.slice(0, MAX_ATTACH_TEXT_CHARS) + note
}

/** 单个文件 -> 内容块（校验 + 读取 + 转换）。 */
async function expandFilePart(path: string): Promise<FileContentBlock[]> {
  const name = basename(path)
  const kind = classifyPath(path)
  if (kind === 'unsupported') throw new Error('暂不支持的文件类型：' + name)
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) throw new Error('文件不存在：' + name)
  if (kind === 'text' && info.size > MAX_TEXT_FILE_BYTES) throw new Error('文件过大：' + name)
  if (kind === 'image' && info.size > MAX_IMAGE_BYTES) throw new Error('文件过大：' + name)
  if (kind === 'pdf' && info.size > MAX_PDF_BYTES) throw new Error('文件过大：' + name)
  if (kind === 'document' && info.size > MAX_DOCUMENT_BYTES) {
    throw new Error('文件过大：' + name)
  }

  if (kind === 'text' || kind === 'pdf' || kind === 'document') {
    const { content, truncated } = await loadFileText(path, getFileExt(path))
    // 标记格式与 ConversationStore.parseBlocks 的折叠正则耦合，改动需同步
    return [
      {
        type: 'text',
        text:
          '【文件：' +
          name +
          '】' +
          LF +
          truncateForLLM(content, truncated) +
          LF +
          '【文件内容结束】'
      }
    ]
  }
  // 图片：标记文本块 + image_url 块（连续二元组，显示端折叠回文件名）
  // 标记格式与 ConversationStore.parseBlocks 的折叠正则耦合，改动需同步
  const mime = IMAGE_MIME[getFileExt(path)] ?? 'application/octet-stream'
  const data = await readFile(path)
  return [
    { type: 'text', text: '【文件：' + name + '】' },
    { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + data.toString('base64') } }
  ]
}

/** parts -> 内容块（空文本块跳过；任一文件失败整体抛错）。 */
export async function expandFileParts(parts: MessagePart[]): Promise<FileContentBlock[]> {
  const blocks: FileContentBlock[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    blocks.push(...(await expandFilePart(part.path)))
  }
  return blocks
}
