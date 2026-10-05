import { readdirSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { loadFileText, MAX_BINARY_BYTES, PREVIEW_PAGE_CHARS } from './FileLoaders'
import { HIDDEN_NAMES, resolveInside } from './path-guard'
import { WordConversionService } from './WordConversionService'

/**
 * 工作空间文件服务（R8-7：自 WorkspaceService 拆分，纯搬移）：目录列表、文本读取
 * （FileLoaders 分发）、Word/PDF/图片/视频字节读取、Word 保存。
 * 工作空间解析经构造注入的 resolveWorkspace（来自 WorkspaceRegistryService）。
 */

/** 文件列表条目（relPath 统一用 '/' 分隔的相对路径，渲染层据此缩进与回传） */
export interface WorkspaceFileEntry {
  name: string
  type: 'dir' | 'file'
  relPath: string
}

/** 文件读取结果：truncated 表示超过大小上限被截断 */
export interface WorkspaceFileContent {
  content: string
  truncated: boolean
  /** 续读游标：truncated 为 true 时回传可继续读取后续内容 */
  cursor?: number
  /** 抽取文本总字符数（转换型文档可提前得知） */
  totalChars?: number
}

/** 工作空间图片原始字节（聊天内嵌本地图片渲染用） */
export interface WorkspaceImageBytes {
  ext: string
  bytes: Uint8Array
}

/** 工作空间视频原始字节（消息/文档内嵌本地视频播放用） */
export interface WorkspaceMediaBytes {
  ext: string
  bytes: Uint8Array
}

/** Word/PDF 预览时主进程返回给渲染层的原始文件字节。 */
export interface WorkspaceFileBinary {
  name: string
  ext: string
  bytes: Uint8Array
}

/** 聊天内嵌工作区图片的格式白名单 */
const WORKSPACE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])

/** 聊天内嵌工作区视频格式白名单 */
const WORKSPACE_MEDIA_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg'])

/** 聊天内嵌工作区视频单文件大小上限（200MB，短视频成片足够） */
const MAX_WORKSPACE_MEDIA_BYTES = 200 * 1024 * 1024

/** 聊天内嵌工作区图片单文件大小上限（20MB） */
const MAX_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024

/** 单层最多返回条目数 */
const MAX_LIST_ITEMS = 200

export class WorkspaceFileService {
  constructor(
    private readonly resolveWorkspace: (
      id: string,
      userId: string
    ) => { id: string; name: string; dir: string } | null,
    private readonly wordConversionService: WordConversionService = new WordConversionService()
  ) {}

  /**
   * 列出工作空间下相对路径目录的条目（顶层传 ''）
   * @throws 工作空间不存在 / 路径越界 / 目标不是目录时抛错
   */
  listFiles(id: string, userId: string, relPath = ''): WorkspaceFileEntry[] {
    const ws = this.resolveWorkspace(id, userId)
    if (!ws) throw new Error('工作空间不存在或目录已移除')
    const target = resolveInside(ws.dir, relPath)
    if (!statSync(target).isDirectory()) throw new Error('不是目录')

    const entries = readdirSync(target, { withFileTypes: true })
      .filter((d) => !HIDDEN_NAMES.has(d.name))
      .map((d) => {
        const entryPath = [relPath, d.name].filter(Boolean).join('/')
        return {
          name: d.name,
          type: d.isDirectory() ? ('dir' as const) : ('file' as const),
          relPath: entryPath
        }
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_LIST_ITEMS)
    return entries
  }

  /**
   * 读取工作空间下文件文本内容（按扩展名分发文本加载器）
   * @throws 工作空间不存在 / 路径越界 / 不是文件 / 二进制（未知扩展名）时抛错
   */
  async readFile(
    id: string,
    userId: string,
    relPath: string,
    cursor?: number
  ): Promise<WorkspaceFileContent> {
    const ws = this.resolveWorkspace(id, userId)
    if (!ws) throw new Error('工作空间不存在或目录已移除')
    const target = resolveInside(ws.dir, relPath)
    if (!statSync(target).isFile()) throw new Error('不是文件')
    const ext = extname(target).toLowerCase().replace(/^\./, '')
    // 预览按 PREVIEW_PAGE_CHARS 分页，渲染层可携带 cursor 续读直至完整读取整篇文档
    return loadFileText(target, ext, { cursor, maxChars: PREVIEW_PAGE_CHARS })
  }

  /** 解析工作空间内文件路径并校验存在性与 containment。 */
  resolveFilePath(id: string, userId: string, relPath: string): string {
    const ws = this.resolveWorkspace(id, userId)
    if (!ws) throw new Error('工作空间不存在或目录已移除')
    const target = resolveInside(ws.dir, relPath)
    if (!statSync(target).isFile()) throw new Error('不是文件')
    return target
  }

  /**
   * 读取工作空间内 Word/PDF 文件的原始字节。
   * docx 直接读取；doc 由主进程先转换为 docx；pdf 按预览上限读取原始字节。
   */
  async readFileBytes(id: string, userId: string, relPath: string): Promise<WorkspaceFileBinary> {
    const target = this.resolveFilePath(id, userId, relPath)
    const ext = extname(target).toLowerCase().replace(/^\./, '')
    const name = basename(target)

    if (ext === 'docx' || ext === 'doc') {
      const bytes = await this.wordConversionService.toDocxForPreview(target)
      return { name, ext: 'docx', bytes }
    }

    if (ext === 'pdf') {
      const buffer = await readFile(target)
      if (buffer.byteLength > MAX_BINARY_BYTES) {
        throw new Error('文件过大，暂不支持预览')
      }
      return { name, ext: 'pdf', bytes: new Uint8Array(buffer) }
    }

    throw new Error('仅支持 doc/docx/pdf 文件的字节预览')
  }

  /** 读取工作空间内图片原始字节（路径校验与图片格式白名单由主进程执行） */
  async readImageBytes(id: string, userId: string, relPath: string): Promise<WorkspaceImageBytes> {
    const target = this.resolveFilePath(id, userId, relPath)
    const ext = extname(target).toLowerCase().replace(/^\./, '')
    if (!WORKSPACE_IMAGE_EXTS.has(ext)) {
      throw new Error('仅支持读取工作区图片文件')
    }
    const buffer = await readFile(target)
    if (buffer.byteLength > MAX_WORKSPACE_IMAGE_BYTES) {
      throw new Error('图片文件过大，暂不支持预览')
    }
    return { ext, bytes: new Uint8Array(buffer) }
  }

  /** 读取工作空间内视频原始字节（路径校验与格式白名单由主进程执行） */
  async readMediaBytes(id: string, userId: string, relPath: string): Promise<WorkspaceMediaBytes> {
    const target = this.resolveFilePath(id, userId, relPath)
    const ext = extname(target).toLowerCase().replace(/^\./, '')
    if (!WORKSPACE_MEDIA_EXTS.has(ext)) {
      throw new Error('仅支持读取工作区视频文件')
    }
    const buffer = await readFile(target)
    if (buffer.byteLength > MAX_WORKSPACE_MEDIA_BYTES) {
      throw new Error('视频文件过大，暂不支持预览')
    }
    return { ext, bytes: new Uint8Array(buffer) }
  }

  /**
   * 保存工作空间内 Word 文件字节。
   * docx 直接写回；doc 需要主进程先将 docx 字节转回 doc，转换失败不覆盖原文件。
   */
  async writeFile(
    id: string,
    userId: string,
    relPath: string,
    bytes: Uint8Array | ArrayBuffer
  ): Promise<void> {
    const target = this.resolveFilePath(id, userId, relPath)
    const ext = extname(target).toLowerCase().replace(/^\./, '')

    if (ext === 'docx') {
      writeFileSync(target, normalizeBytes(bytes))
      return
    }

    if (ext === 'doc') {
      const legacyDoc = await this.wordConversionService.toLegacyDoc(bytes)
      writeFileSync(target, legacyDoc)
      return
    }

    throw new Error('仅支持 doc/docx 文件的 Word 保存')
  }
}

function normalizeBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw new Error('无效的文件字节')
}
