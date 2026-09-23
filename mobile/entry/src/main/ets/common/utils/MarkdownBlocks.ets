/**
 * Markdown → 内容块(与后端返回的文章格式对应)。
 *
 * 支持:标题(#~####)、无序/有序列表、表格(| a | b |)、图片(![](src))、段落;
 * 段落内保留 **加粗**(由 MarkdownParser 渲染),图片单独成块交给 ArtifactImage。
 * 图片地址通过 resolveImageSrc 解析为产物接口地址(需要 threadId/basePath)。
 */

import { ContentBlock, HeadingBlock, ImageBlock, ListBlock, TableBlock, TextBlock, VideoBlock } from '../types/Models'
import {
  MarkdownImageContext,
  extractVideoSources,
  resolveImageSrc,
  resolveVideoSrc,
  videoBlockCaption
} from './MarkdownArtifacts'

/** 是否表格分隔行(|---|:--:|) */
function isTableDivider(line: string): boolean {
  const cells: Array<string> = splitTableRow(line)
  if (cells.length === 0) {
    return false
  }
  for (let i = 0; i < cells.length; i++) {
    if (!/^:?-{2,}:?$/.test(cells[i].trim())) {
      return false
    }
  }
  return true
}

/** 拆分表格行:去掉首尾竖线后按 | 切分 */
function splitTableRow(line: string): Array<string> {
  const trimmed: string = line.trim()
  if (!trimmed.startsWith('|')) {
    return []
  }
  let body: string = trimmed
  if (body.startsWith('|')) {
    body = body.substring(1)
  }
  if (body.endsWith('|')) {
    body = body.substring(0, body.length - 1)
  }
  const parts: Array<string> = body.split('|')
  const out: Array<string> = []
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i].trim())
  }
  return out
}

/** 解析行内图片:返回文本片段与图片块序列 */
function parseInline(src: string, alt: string, context: MarkdownImageContext, textOut: Array<string>, images: Array<ImageBlock>): void {
  const resolved: string = resolveImageSrc(src, context)
  images.push({ type: 'image', src: resolved, alt: alt } as ImageBlock)
}

/** 提取文本行中的图片(保序),其余文本按段落输出 */
function parseParagraphLines(
  lines: Array<string>,
  context: MarkdownImageContext,
  out: Array<ContentBlock>
): void {
  const textParts: Array<string> = []
  const re: RegExp = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i]
    let cursor: number = 0
    let match: RegExpExecArray | null = re.exec(line)
    while (match !== null) {
      const before: string = line.substring(cursor, match.index).trim()
      if (before !== '') {
        textParts.push(before)
      }
      const images: Array<ImageBlock> = []
      parseInline(match[2], match[1], context, textParts, images)
      // 图片位于段落中间时,先把已积累的文本落盘,保证图文顺序
      for (let k = 0; k < images.length; k++) {
        flushParagraph(textParts, out)
        out.push(images[k])
      }
      cursor = match.index + match[0].length
      match = re.exec(line)
    }
    const rest: string = line.substring(cursor).trim()
    if (rest !== '') {
      textParts.push(rest)
    }
  }
  flushParagraph(textParts, out)
}

/** 把累计文本行合并为一个段落块 */
function flushParagraph(parts: Array<string>, out: Array<ContentBlock>): void {
  if (parts.length === 0) {
    return
  }
  const content: string = parts.join(' ')
  parts.length = 0
  if (content.trim() === '') {
    return
  }
  out.push({ type: 'text', content: content } as TextBlock)
}

/**
 * 把 Markdown 文本转换为内容块。
 *
 * @param markdown 后端返回的文章正文
 * @param context 配图解析上下文(threadId / basePath / artifactPaths / apiBaseUrl)
 */
export function markdownToBlocks(markdown: string, context: MarkdownImageContext): Array<ContentBlock> {
  const out: Array<ContentBlock> = []
  if (markdown.trim() === '') {
    return out
  }

  const lines: Array<string> = markdown.split('\n')
  let buffer: Array<string> = []
  let index: number = 0

  while (index < lines.length) {
    const raw: string = lines[index]
    const line: string = raw.trim()

    if (line === '') {
      parseParagraphLines(buffer, context, out)
      buffer = []
      index += 1
      continue
    }

    // 表格:表头 + 分隔行
    if (line.startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      parseParagraphLines(buffer, context, out)
      buffer = []
      const headers: Array<string> = splitTableRow(line)
      const rows: Array<Array<string>> = []
      index += 2
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells: Array<string> = splitTableRow(lines[index])
        if (cells.length > 0) {
          rows.push(cells)
        }
        index += 1
      }
      out.push({ type: 'table', headers: headers, rows: rows } as TableBlock)
      continue
    }

    // 成片:HTML5 <video> 标签(可能多行,含内嵌 <source>)
    if (line.startsWith('<video')) {
      parseParagraphLines(buffer, context, out)
      buffer = []
      let blockText: string = line
      while (blockText.indexOf('</video>') < 0 && index + 1 < lines.length) {
        index += 1
        blockText += '\n' + lines[index].trim()
      }
      const sources: Array<string> = extractVideoSources(blockText)
      if (sources.length > 0) {
        out.push({
          type: 'video',
          src: resolveVideoSrc(sources[0], context),
          caption: videoBlockCaption(blockText)
        } as VideoBlock)
      }
      index += 1
      continue
    }

    // 标题
    if (line.startsWith('#')) {
      parseParagraphLines(buffer, context, out)
      buffer = []
      let level: number = 0
      while (level < line.length && line.charAt(level) === '#') {
        level += 1
      }
      const content: string = line.substring(level).trim()
      if (content !== '') {
        out.push({ type: 'heading', content: content } as HeadingBlock)
      }
      index += 1
      continue
    }

    // 列表(连续行合并为一个列表块)
    if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\.\s/.test(line)) {
      parseParagraphLines(buffer, context, out)
      buffer = []
      const items: Array<string> = []
      while (index < lines.length) {
        const itemLine: string = lines[index].trim()
        if (itemLine.startsWith('- ') || itemLine.startsWith('* ')) {
          items.push(itemLine.substring(2).trim())
        } else if (/^\d+\.\s/.test(itemLine)) {
          const dot: number = itemLine.indexOf('.')
          items.push(itemLine.substring(dot + 1).trim())
        } else {
          break
        }
        index += 1
      }
      if (items.length > 0) {
        out.push({ type: 'list', items: items } as ListBlock)
      }
      continue
    }

    buffer.push(line)
    index += 1
  }

  parseParagraphLines(buffer, context, out)
  return out
}