import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import type { KnowledgeChunk, KnowledgeChunkStrategy } from './types'

/**
 * 文本切片。
 *
 * 策略与设置页 `knowledge.chunkStrategy` 四选一对应：
 * - `recursive`：官方 RecursiveCharacterTextSplitter（分隔符按中英文标点分级），默认兜底；
 * - `fixed`：按 token 估算的定长窗口 + 重叠；
 * - `markdown`：按 ATX 标题分段（标题路径写 heading），段内再递归切；
 * - `semantic`：句向量相似度断点（需嵌入端点；不可用时由调用方降级 recursive）。
 *
 * 所有策略都产出 `charStart/charEnd`，可用 `text.slice(start, end)` 精确还原切片内容；
 * 这是引用定位与「切片是否漏字」回归用例的基础。
 */

/** token 估算：CJK 每字记 1，其余按 4 字符 ≈ 1 token（与设置页口径一致） */
export function estimateTokens(text: string): number {
  let tokens = 0
  let latin = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isCjk(code)) {
      if (latin > 0) {
        tokens += Math.ceil(latin / 4)
        latin = 0
      }
      tokens += 1
    } else {
      latin += 1
    }
  }
  if (latin > 0) tokens += Math.ceil(latin / 4)
  return tokens
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) // 全角标点等
  )
}

/** 递归策略的分隔符（从大到小；空串兜底硬切，保证超长单句也能出块） */
const RECURSIVE_SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '.', '!', '?', ';', '，', ',', ' ', '']

export interface ChunkOptions {
  strategy: KnowledgeChunkStrategy
  /** 目标块长（token 数，按 estimateTokens 口径） */
  chunkSize: number
  /** 相邻块重叠（token 数） */
  chunkOverlap: number
  /** semantic 策略用：批量句向量（缺省时调用方应降级为 recursive） */
  embedSentences?: (sentences: string[]) => Promise<Float32Array[]>
}

export interface ChunkResult {
  chunks: KnowledgeChunk[]
  /** 非致命降级告警（如 semantic 无端点降级 recursive、overlap 被钳制） */
  warning?: string
}

export class ChunkingService {
  async split(text: string, options: ChunkOptions): Promise<ChunkResult> {
    const normalized = normalizeText(text)
    if (!normalized.trim()) return { chunks: [] }

    let { chunkSize, chunkOverlap } = options
    const warnings: string[] = []
    if (chunkSize < 1) chunkSize = 1
    if (chunkOverlap >= chunkSize) {
      chunkOverlap = Math.floor(chunkSize / 2)
      warnings.push(`重叠(${options.chunkOverlap})不小于块长(${chunkSize})，已钳制为 ${chunkOverlap}`)
    }

    let chunks: KnowledgeChunk[]
    switch (options.strategy) {
      case 'fixed':
        chunks = this.splitFixed(normalized, chunkSize, chunkOverlap)
        break
      case 'markdown':
        chunks = await this.splitMarkdown(normalized, chunkSize, chunkOverlap)
        break
      case 'semantic':
        if (!options.embedSentences) {
          warnings.push('未配置嵌入端点，语义切片降级为递归切片')
          chunks = await this.splitRecursive(normalized, chunkSize, chunkOverlap)
        } else {
          chunks = await this.splitSemantic(normalized, chunkSize, chunkOverlap, options.embedSentences)
        }
        break
      case 'recursive':
      default:
        chunks = await this.splitRecursive(normalized, chunkSize, chunkOverlap)
        break
    }

    // 统一重排 chunk.index（0 起连续），保证 (doc_id, chunk_index) 唯一
    chunks.forEach((chunk, index) => {
      chunk.index = index
    })
    return { chunks, warning: warnings.length ? warnings.join('；') : undefined }
  }

  // ── recursive ──

  private async splitRecursive(
    text: string,
    chunkSize: number,
    chunkOverlap: number
  ): Promise<KnowledgeChunk[]> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: RECURSIVE_SEPARATORS,
      keepSeparator: false,
      lengthFunction: (value) => estimateTokens(value)
    })
    const pieces = await splitter.splitText(text)
    return locatePieces(text, pieces)
  }

  // ── fixed ──

  private splitFixed(text: string, chunkSize: number, chunkOverlap: number): KnowledgeChunk[] {
    const chunks: KnowledgeChunk[] = []
    const codePoints = Array.from(text)
    let start = 0
    while (start < codePoints.length) {
      let tokens = 0
      let end = start
      // 逐字符累积到目标块长
      while (end < codePoints.length && tokens < chunkSize) {
        tokens += estimateTokens(codePoints[end])
        end += 1
      }
      const content = codePoints.slice(start, end).join('')
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: estimateTokens(content),
        charStart: start,
        charEnd: end
      })
      if (end >= codePoints.length) break
      // 回退重叠（按 token 计）
      let back = 0
      let cursor = end
      while (cursor > start && back < chunkOverlap) {
        cursor -= 1
        back += estimateTokens(codePoints[cursor])
      }
      start = cursor > start ? cursor : end
    }
    return chunks
  }

  // ── markdown ──

  private async splitMarkdown(
    text: string,
    chunkSize: number,
    chunkOverlap: number
  ): Promise<KnowledgeChunk[]> {
    const sections: Array<{ heading: string | undefined; body: string; start: number }> = []
    const lines = text.split('\n')
    let headingStack: string[] = []
    let currentHeading: string | undefined
    let buffer: string[] = []
    let bufferStart = 0
    let cursor = 0

    const flush = (): void => {
      const body = buffer.join('\n')
      if (body.trim()) sections.push({ heading: currentHeading, body, start: bufferStart })
      buffer = []
    }

    for (const line of lines) {
      const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
      if (match) {
        flush()
        const level = match[1].length
        headingStack = headingStack.slice(0, level - 1)
        headingStack[level - 1] = match[2]
        currentHeading = headingStack.filter(Boolean).join(' / ')
        bufferStart = cursor + line.length + 1
      } else {
        if (buffer.length === 0) bufferStart = cursor
        buffer.push(line)
      }
      cursor += line.length + 1
    }
    flush()

    if (!sections.length) return this.splitRecursive(text, chunkSize, chunkOverlap)

    const chunks: KnowledgeChunk[] = []
    for (const section of sections) {
      if (estimateTokens(section.body) <= chunkSize) {
        chunks.push({
          index: chunks.length,
          content: section.body,
          tokenCount: estimateTokens(section.body),
          heading: section.heading,
          charStart: section.start,
          charEnd: section.start + section.body.length
        })
        continue
      }
      // 段内再递归；把块内偏移换算回全文偏移
      const inner = await this.splitRecursive(section.body, chunkSize, chunkOverlap)
      for (const piece of inner) {
        chunks.push({
          ...piece,
          index: chunks.length,
          heading: section.heading,
          charStart: section.start + piece.charStart,
          charEnd: section.start + piece.charEnd
        })
      }
    }
    return chunks
  }

  // ── semantic ──

  private async splitSemantic(
    text: string,
    chunkSize: number,
    chunkOverlap: number,
    embedSentences: (sentences: string[]) => Promise<Float32Array[]>
  ): Promise<KnowledgeChunk[]> {
    const sentences = splitSentences(text)
    if (sentences.length <= 1) return this.splitRecursive(text, chunkSize, chunkOverlap)

    let vectors: Float32Array[] = []
    try {
      vectors = await embedSentences(sentences.map((sentence) => sentence.text))
    } catch {
      // 断点向量拿不到就退回递归，不让语义切片的失败阻断索引
      return this.splitRecursive(text, chunkSize, chunkOverlap)
    }

    // 相邻句相似度低于阈值处作为断点
    const threshold = 0.75
    const breaks = new Set<number>()
    for (let i = 1; i < sentences.length; i += 1) {
      const sim = cosine(vectors[i - 1], vectors[i])
      if (sim < threshold) breaks.add(i)
    }

    // 按断点聚合成块，块长超过 chunkSize 时强制断开
    const chunks: KnowledgeChunk[] = []
    let startIndex = 0
    let tokens = 0
    const pushChunk = (endIndex: number): void => {
      if (endIndex <= startIndex) return
      const first = sentences[startIndex]
      const last = sentences[endIndex - 1]
      const content = text.slice(first.start, last.end)
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: estimateTokens(content),
        charStart: first.start,
        charEnd: last.end
      })
    }
    for (let i = 0; i < sentences.length; i += 1) {
      tokens += sentences[i].tokens
      const isBreak = breaks.has(i + 1) || i === sentences.length - 1
      if ((tokens >= chunkSize || isBreak) && i + 1 > startIndex) {
        pushChunk(i + 1)
        // 带重叠地开始下一块
        let back = 0
        let next = i + 1
        while (next > startIndex && back < chunkOverlap) {
          next -= 1
          back += sentences[next].tokens
        }
        startIndex = next > startIndex ? next : i + 1
        tokens = sentences.slice(startIndex, i + 1).reduce((sum, item) => sum + item.tokens, 0)
      }
    }
    return chunks.length ? chunks : this.splitRecursive(text, chunkSize, chunkOverlap)
  }
}

/** 句切分（中英标点；保留标点在句尾，偏移可还原） */
export function splitSentences(text: string): Array<{ text: string; start: number; end: number; tokens: number }> {
  const result: Array<{ text: string; start: number; end: number; tokens: number }> = []
  const codePoints = Array.from(text)
  let start = 0
  for (let i = 0; i < codePoints.length; i += 1) {
    const char = codePoints[i]
    const isEnd = '。！？!?；;\n'.includes(char)
    if (!isEnd) continue
    // 连续标点/空白并入本句
    let end = i + 1
    while (end < codePoints.length && '”"\'\'）)】」』'.includes(codePoints[end])) end += 1
    const content = codePoints.slice(start, end).join('')
    if (content.trim()) {
      result.push({ text: content, start, end, tokens: estimateTokens(content) })
    }
    start = end
  }
  if (start < codePoints.length) {
    const content = codePoints.slice(start).join('')
    if (content.trim()) {
      result.push({ text: content, start, end: codePoints.length, tokens: estimateTokens(content) })
    }
  }
  return result
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** 统一换行符，让 charStart/charEnd 与落库文本一致 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 把切片文本映射回原文偏移。
 *
 * RecursiveCharacterTextSplitter 只返回字符串、不带偏移；块内容都是原文的子串
 * （分隔符被丢弃、小块拼接用分隔符还原），因此用「游标 + indexOf」顺序定位。
 * 定位不到时（极端空白差异）退化为顺序区间，保证不抛错、不丢块。
 */
function locatePieces(text: string, pieces: string[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = []
  let cursor = 0
  for (const piece of pieces) {
    if (!piece) continue
    let start = text.indexOf(piece, cursor)
    if (start === -1) start = text.indexOf(piece)
    if (start === -1) {
      start = cursor
      chunks.push({
        index: chunks.length,
        content: piece,
        tokenCount: estimateTokens(piece),
        charStart: start,
        charEnd: Math.min(text.length, start + piece.length)
      })
      cursor = Math.min(text.length, start + piece.length)
      continue
    }
    const end = start + piece.length
    chunks.push({
      index: chunks.length,
      content: piece,
      tokenCount: estimateTokens(piece),
      charStart: start,
      charEnd: end
    })
    cursor = end
  }
  return chunks
}
