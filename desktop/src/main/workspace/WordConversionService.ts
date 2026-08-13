import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { extname, join } from 'path'

/** Word 编辑器预览/保存允许的原始文件上限，避免 IPC 传输异常大的文档。 */
export const MAX_WORD_EDITOR_BYTES = 50 * 1024 * 1024

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new Error('无效的文件字节')
}

function runLibreOffice(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 60_000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function assertBytesWithinLimit(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_WORD_EDITOR_BYTES) {
    throw new Error(`文件过大，暂不支持超过 ${MAX_WORD_EDITOR_BYTES / 1024 / 1024}MB 的 Word 文档`)
  }
}

/**
 * Word 格式转换服务。
 *
 * docx-editor 只能处理 OOXML 格式的 docx，无法直接解析老式二进制 doc。
 * 因此打开 .doc 时先转换为 docx；保存 .doc 时再把 docx 转回 doc。
 */
export class WordConversionService {
  /** 打开文件时：doc 转 docx，docx 直接读取字节。 */
  async toDocxForPreview(sourcePath: string): Promise<Uint8Array> {
    const ext = extname(sourcePath).toLowerCase().replace(/^\./, '')
    if (ext === 'docx') {
      const buffer = await readFile(sourcePath)
      const bytes = new Uint8Array(buffer)
      assertBytesWithinLimit(bytes)
      return bytes
    }

    if (ext !== 'doc') {
      throw new Error('仅支持 doc/docx 文件的 Word 预览')
    }

    const binary = locateLibreOffice()
    const tmpDir = await mkdtemp(join(tmpdir(), 'ke-work-doc-open-'))
    try {
      await runLibreOffice(binary, [
        '--headless',
        '--convert-to',
        'docx',
        '--outdir',
        tmpDir,
        sourcePath
      ])
      const convertedPath = await findConvertedFile(tmpDir, 'docx')
      const bytes = new Uint8Array(await readFile(convertedPath))
      assertBytesWithinLimit(bytes)
      return bytes
    } catch (error) {
      throw new Error(`无法预览 .doc 文件：未检测到 LibreOffice 或转换失败（${(error as Error).message}）`)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  /** 保存 .doc 时：docx 字节转回 doc 字节。 */
  async toLegacyDoc(docxBytes: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
    const source = toUint8Array(docxBytes)
    assertBytesWithinLimit(source)

    const binary = locateLibreOffice()
    const tmpDir = await mkdtemp(join(tmpdir(), 'ke-work-doc-save-'))
    const sourcePath = join(tmpDir, 'converted.docx')

    try {
      await writeFile(sourcePath, source)
      await runLibreOffice(binary, [
        '--headless',
        '--convert-to',
        'doc',
        '--outdir',
        tmpDir,
        sourcePath
      ])
      const convertedPath = await findConvertedFile(tmpDir, 'doc')
      const bytes = new Uint8Array(await readFile(convertedPath))
      assertBytesWithinLimit(bytes)
      return bytes
    } catch (error) {
      throw new Error(`保存 .doc 失败：未检测到 LibreOffice 或转换失败（${(error as Error).message}）`)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }
}

async function findConvertedFile(dir: string, ext: string): Promise<string> {
  const files = await readdir(dir)
  const target = files.find((name) => name.toLowerCase().endsWith(`.${ext}`))
  if (!target) throw new Error(`未找到转换后的 .${ext} 文件`)
  return join(dir, target)
}

function locateLibreOffice(): string {
  const candidates = [
    process.env.LIBREOFFICE_BINARY,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/snap/bin/libreoffice'
  ].filter((candidate): candidate is string => Boolean(candidate))

  const existing = candidates.find((candidate) => existsSync(candidate))
  return existing ?? 'soffice'
}
