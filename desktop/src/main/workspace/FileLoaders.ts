import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { createRequire } from 'module'
import { dirname } from 'path'
import { TextDecoder } from 'util'
import { unzipSync } from 'fflate'
import { extractRawText } from 'mammoth'
import * as XLSX from 'xlsx'
import DOMMatrix from 'dommatrix'

// pdfjs-dist 的 cmaps/standard_fonts 需要通过本地文件路径提供给 Node 侧加载器。
// 这里按 package.json 位置推导包根目录，避免依赖 process.cwd()，打包后更稳定。
const pdfjsDistRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replace(
  /\\/g,
  '/'
)
const PDF_CMAP_URL = `${pdfjsDistRoot}/cmaps/`
const PDF_STANDARD_FONT_DATA_URL = `${pdfjsDistRoot}/standard_fonts/`

export interface LoadedText {
  content: string
  truncated: boolean
  /**
   * 续读游标：truncated 为 true 时把该值作为下次 options.cursor 传入，
   * 即可继续读取后续内容，直到 truncated 为 false，从而完整读取整篇文档。
   * 纯文本为字节偏移；docx/xlsx/pptx/pdf 为抽取文本的字符偏移。
   */
  cursor?: number
  /** 抽取文本总字符数（仅转换型文档可提前得知） */
  totalChars?: number
}

/** 文本读取选项：支持按游标分页续读 */
export interface LoadTextOptions {
  /** 续读游标（上次返回的 cursor），缺省从头读取 */
  cursor?: number
  /** 单次读取上限（字符数；纯文本按等量字节读取），缺省 MAX_TEXT_CHARS */
  maxChars?: number
}

/** 二进制文档原始文件上限（超过直接提示，不解析） */
export const MAX_BINARY_BYTES = 20 * 1024 * 1024
/** 默认单次读取上限：智能体附件等既有调用保持 200KB，单位为字符 */
export const MAX_TEXT_CHARS = 200 * 1024
/** 文件预览分页步长：按该长度分页续读，直到读完整篇文档 */
export const PREVIEW_PAGE_CHARS = 512 * 1024
/** 转换型文档（docx/xlsx/pptx/pdf）抽取文本总上限，避免超大文档拖垮主进程 */
export const MAX_CONVERTED_TEXT_CHARS = 2 * 1024 * 1024
/** pptx 解压后总字节预算（防 zip bomb，仅解压侧防御，不对外暴露） */
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024

const BINARY_SNIFF_BYTES = 4 * 1024

/** pptx slide XML：段落与文本 run */
const A_P_REGEX = /<a:p[\s\S]*?<\/a:p>/g
// a:t 后必须紧跟空格或 >，避免误匹配 <a:tabLst>/<a:tab .../> 等以 a:t 开头的制表位元素
const A_T_REGEX = /<a:t(?:[ >])[\s\S]*?<\/a:t>/g

/**
 * 最小 XML 实体反转义（OOXML 文本中的 &amp; 等）。
 * 仅处理常用命名实体，预览用最小集，其余实体保持原样。
 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 归一化续读游标：非法或负值按 0（从头读取）处理 */
function normalizeCursor(cursor: number | undefined): number {
  if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor <= 0) return 0
  return Math.floor(cursor)
}

function normalizePageChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars <= 0) {
    return MAX_TEXT_CHARS
  }
  return Math.floor(maxChars)
}

/** 按游标截取抽取后的文本，truncated 为 true 时给出续读游标 */
function sliceText(text: string, cursor: number, maxChars: number): LoadedText {
  if (cursor >= text.length) return { content: '', truncated: false, totalChars: text.length }
  const end = cursor + maxChars
  if (end >= text.length) {
    return { content: text.slice(cursor), truncated: false, totalChars: text.length }
  }
  return { content: text.slice(cursor, end), truncated: true, cursor: end, totalChars: text.length }
}

/**
 * UTF-8 安全长度：末尾若落在多字节字符中间则回退到完整字符边界，
 * 避免分页读取时把汉字截断成替换字符。
 */
function utf8SafeLength(buf: Buffer): number {
  const len = buf.length
  for (let back = 1; back <= 3 && back <= len; back += 1) {
    const byte = buf[len - back]
    if (byte < 0x80) return len
    if (byte >= 0xc0) {
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
      return back === need ? len : len - back
    }
  }
  return len
}

/** 读取纯文本分页（cursor 为字节偏移）：二进制内容在首页探测时直接拒绝 */
function readTextPage(filePath: string, cursor: number, maxBytes: number): LoadedText {
  const size = statSync(filePath).size
  if (cursor >= size) return { content: '', truncated: false }
  const want = Math.min(maxBytes, size - cursor)
  const buf = Buffer.alloc(want)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buf, 0, want, cursor)
  } finally {
    closeSync(fd)
  }
  if (cursor === 0 && buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new Error('二进制文件暂不支持预览')
  }
  const usable = utf8SafeLength(buf) || want
  const next = cursor + usable
  const content = new TextDecoder('utf-8').decode(buf.subarray(0, usable))
  if (next >= size) return { content, truncated: false }
  return { content, truncated: true, cursor: next }
}

/** 二进制文档原始文件不得超过 20MB */
function assertNotTooBig(filePath: string): void {
  if (statSync(filePath).size > MAX_BINARY_BYTES) throw new Error('文件过大，暂不支持预览')
}

/** 二进制文档原始字节（含 20MB 上限） */
function readBytes(filePath: string): Buffer {
  assertNotTooBig(filePath)
  return readFileSync(filePath)
}

async function loadDocx(filePath: string, cursor: number, maxChars: number): Promise<LoadedText> {
  assertNotTooBig(filePath)
  const { value } = await extractRawText({ path: filePath })
  return sliceText(value, cursor, maxChars)
}

async function loadXlsx(filePath: string, cursor: number, maxChars: number): Promise<LoadedText> {
  assertNotTooBig(filePath)
  const workbook = XLSX.readFile(filePath)
  const parts = workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name])
    return `=== Sheet: ${name} ===\n${csv}`
  })
  return sliceText(parts.join('\n\n'), cursor, maxChars)
}

async function loadPptx(filePath: string, cursor: number, maxChars: number): Promise<LoadedText> {
  const files = unzipSync(new Uint8Array(readBytes(filePath)))
  const totalBytes = Object.values(files).reduce((sum, f) => sum + f.length, 0)
  if (totalBytes > MAX_DECOMPRESSED_BYTES) throw new Error('文件过大，暂不支持预览')
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/\d+/)?.[0] ?? 0)
      const nb = Number(b.match(/\d+/)?.[0] ?? 0)
      return na - nb
    })
  if (slideNames.length === 0) throw new Error('未找到幻灯片内容')
  const slides = slideNames.map((name) => {
    const xml = new TextDecoder().decode(files[name])
    const paragraphs = xml.match(A_P_REGEX) ?? []
    return paragraphs
      .map((p) => {
        const runs = p.match(A_T_REGEX) ?? []
        // 与 A_T_REGEX 一致：仅剥离紧跟空格或 > 的 a:t 标签，不碰 tabLst 等其他元素
        return runs.map((r) => unescapeXml(r.replace(/<\/?a:t(?=[ >])[^>]*>/g, ''))).join('')
      })
      .join('\n')
  })
  return sliceText(slides.join('\n\n'), cursor, maxChars)
}

async function loadPdf(filePath: string, cursor: number, maxChars: number): Promise<LoadedText> {
  // Node 环境缺少浏览器原生 DOMMatrix；部分 pdfjs-dist 版本会在模块顶层使用它。
  // 因此必须先补齐全局，再动态 import legacy 构建。
  const globalScope = globalThis as typeof globalThis & { DOMMatrix?: typeof DOMMatrix }
  if (!globalScope.DOMMatrix) {
    globalScope.DOMMatrix = DOMMatrix
  }

  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const data = new Uint8Array(readBytes(filePath))
  const loadingTask = pdfjs.getDocument({
    data,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL
  })

  try {
    const document = await loadingTask.promise
    const pages: string[] = []
    let totalLength = 0
    const stopAt = Math.min(cursor + maxChars, MAX_CONVERTED_TEXT_CHARS)

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const textContent = await page.getTextContent()
      let pageText = ''

      for (const rawItem of textContent.items) {
        if (!('str' in rawItem)) continue
        pageText += rawItem.str
        if (rawItem.hasEOL) pageText += '\n'
      }

      await page.cleanup()
      pages.push(pageText)
      totalLength += pageText.length + 2

      if (totalLength >= stopAt) break
    }

    return sliceText(pages.join('\n\n'), cursor, maxChars)
  } finally {
    await loadingTask.destroy()
  }
}

/**
 * 按扩展名选择文本加载器并提取文本（ext 为小写、无点）。
 * - docx/xlsx/pptx/pdf 走专用加载器（≤20MB），抽取后按 options.maxChars 分页续读
 * - ppt 旧二进制格式不支持
 * - 其余视为文本：按 options.maxChars 分页、前 4KB NUL 嗅探拒绝二进制、UTF-8 解码
 */
export async function loadFileText(
  filePath: string,
  ext: string,
  options: LoadTextOptions = {}
): Promise<LoadedText> {
  const cursor = normalizeCursor(options.cursor)
  const pageChars = normalizePageChars(options.maxChars)
  switch (ext) {
    case 'docx':
      return loadDocx(filePath, cursor, pageChars)
    case 'xlsx':
      return loadXlsx(filePath, cursor, pageChars)
    case 'pptx':
      return loadPptx(filePath, cursor, pageChars)
    case 'pdf':
      return loadPdf(filePath, cursor, pageChars)
    case 'ppt':
      throw new Error('该格式暂不支持预览')
    default: {
      // 纯文本按游标分页读取，首页做 NUL 探测拒绝二进制；可反复续读直到读完整篇
      return readTextPage(filePath, cursor, pageChars)
    }
  }
}
