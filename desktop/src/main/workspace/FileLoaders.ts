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
}

/** 二进制文档原始文件上限（超过直接提示，不解析） */
export const MAX_BINARY_BYTES = 20 * 1024 * 1024
/** 提取/读取文本上限（与现有预览 200KB 一致，单位为字符） */
export const MAX_TEXT_CHARS = 200 * 1024
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

/** 提取文本超过上限时截断 */
function truncateText(text: string): LoadedText {
  if (text.length <= MAX_TEXT_CHARS) return { content: text, truncated: false }
  return { content: text.slice(0, MAX_TEXT_CHARS), truncated: true }
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

async function loadDocx(filePath: string): Promise<LoadedText> {
  assertNotTooBig(filePath)
  const { value } = await extractRawText({ path: filePath })
  return truncateText(value)
}

async function loadXlsx(filePath: string): Promise<LoadedText> {
  assertNotTooBig(filePath)
  const workbook = XLSX.readFile(filePath)
  const parts = workbook.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name])
    return `=== Sheet: ${name} ===\n${csv}`
  })
  return truncateText(parts.join('\n\n'))
}

async function loadPptx(filePath: string): Promise<LoadedText> {
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
  return truncateText(slides.join('\n\n'))
}

async function loadPdf(filePath: string): Promise<LoadedText> {
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

      if (totalLength >= MAX_TEXT_CHARS) break
    }

    return truncateText(pages.join('\n\n'))
  } finally {
    await loadingTask.destroy()
  }
}

/**
 * 按扩展名选择文本加载器并提取文本（ext 为小写、无点）。
 * - docx/xlsx/pptx/pdf 走专用加载器（≤20MB，提取后 200KB 截断）
 * - ppt 旧二进制格式不支持
 * - 其余视为文本：读 ≤200KB、前 4KB NUL 嗅探拒绝二进制、UTF-8 解码
 */
export async function loadFileText(filePath: string, ext: string): Promise<LoadedText> {
  switch (ext) {
    case 'docx':
      return loadDocx(filePath)
    case 'xlsx':
      return loadXlsx(filePath)
    case 'pptx':
      return loadPptx(filePath)
    case 'pdf':
      return loadPdf(filePath)
    case 'ppt':
      throw new Error('该格式暂不支持预览')
    default: {
      // 与旧 readFile 行为一致：字节级 200KB 截断 + NUL 嗅探
      const size = statSync(filePath).size
      const truncated = size > 200 * 1024
      const buf = Buffer.alloc(Math.min(size, 200 * 1024))
      const fd = openSync(filePath, 'r')
      try {
        readSync(fd, buf, 0, buf.length, 0)
      } finally {
        closeSync(fd)
      }
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new Error('二进制文件暂不支持预览')
      return { content: new TextDecoder('utf-8').decode(buf), truncated }
    }
  }
}
