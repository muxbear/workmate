import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'path'
import { readFile } from 'fs/promises'
import { loadFileText, MAX_BINARY_BYTES, PREVIEW_PAGE_CHARS } from '../workspace/FileLoaders'
import type { KnowledgeStore } from './KnowledgeStore'
import type {
  KnowledgeDocumentMeta,
  KnowledgeDocumentRow,
  KnowledgeImportItem,
  KnowledgeImportResult,
  KnowledgeIndexState
} from './types'

/** 上传限制（来自「知识库设置 → 文件上传」，主进程为权威） */
export interface KnowledgeUploadLimits {
  maxUploadSizeMB: number
  maxFilesPerBatch: number
  uploadTimeoutMinutes: number
}

export interface KnowledgeFileServiceDeps {
  /** 知识库根目录（<knowledge.directory>） */
  getDir: () => string
  getLimits: () => KnowledgeUploadLimits
}

/** 文件/文件夹名上限与非法字符（与页面弹窗一致，主进程为权威） */
const NAME_MAX_LEN = 60
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 知识库内可作为 Markdown 插图渲染的图片扩展名 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
/** 单张图片读取上限，避免超大图片撑爆渲染层 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 文档行 → 渲染层可见元信息（剥掉 storage_path / user_id / hash） */
export function toDocumentMeta(row: KnowledgeDocumentRow): KnowledgeDocumentMeta {
  return {
    id: row.id,
    kbId: row.kbId,
    name: row.name,
    type: row.type,
    sizeBytes: row.sizeBytes,
    relPath: row.relPath,
    indexState: row.indexState,
    status: row.status,
    errorMessage: row.errorMessage,
    uploadedAt: row.uploadedAt,
    updatedAt: row.updatedAt
  }
}

/**
 * 知识库文件服务：导入落盘、重命名、删除、读取
 *
 * 存储约定（与方案第九章一致）：
 * - 磁盘按文档隔离：`<knowledge.directory>/files/<kbId>/<docId>/<原文件名>`
 *   —— 重命名不改磁盘路径、内容哈希去重稳定；
 * - 文件树是**逻辑结构**，由 `rel_path` 还原，磁盘不做目录镜像；
 * - 渲染层只传相对路径与文件 ID，绝对路径一律主进程解析。
 */
export class KnowledgeFileService {
  private readonly store: KnowledgeStore
  private readonly deps: KnowledgeFileServiceDeps

  constructor(store: KnowledgeStore, deps: KnowledgeFileServiceDeps) {
    this.store = store
    this.deps = deps
  }

  /** 某知识库的文件根目录（files/<kbId>） */
  private kbRoot(kbId: string): string {
    return join(this.deps.getDir(), 'files', kbId)
  }

  /**
   * 导入文件（保留上传时的目录结构）。
   *
   * 本阶段只支持 `indexState = 'none'`（只上传文件）：索引相关能力
   * （默认索引 / 自定义索引）尚未实现，传其它值直接报错，
   * 避免出现「以为建了索引其实没有」的假象。
   */
  importDocuments(
    userId: string,
    kbId: string,
    items: KnowledgeImportItem[],
    indexState: KnowledgeIndexState = 'none'
  ): KnowledgeImportResult {
    if (indexState !== 'none') {
      throw new Error('索引功能尚未开放，本次仅支持「只上传文件」')
    }
    if (!this.store.getBase(userId, kbId)) throw new Error('知识库不存在')
    const limits = this.deps.getLimits()
    const maxBytes = Math.max(1, limits.maxUploadSizeMB) * 1024 * 1024
    const deadline = Date.now() + Math.max(1, limits.uploadTimeoutMinutes) * 60 * 1000

    const result: KnowledgeImportResult = { accepted: [], skipped: [], failed: [] }
    const queue = Array.isArray(items) ? items : []

    queue.forEach((item, index) => {
      const rawRel = String(item?.relPath ?? '')
      const fallbackName = basename(rawRel) || '未命名文件'
      if (index >= limits.maxFilesPerBatch) {
        result.skipped.push({
          name: fallbackName,
          relPath: rawRel,
          reason: `超出单批次上限（${limits.maxFilesPerBatch} 个）`
        })
        return
      }
      if (Date.now() > deadline) {
        result.failed.push({
          name: fallbackName,
          relPath: rawRel,
          reason: `超出上传超时（${limits.uploadTimeoutMinutes} 分钟）`
        })
        return
      }

      try {
        const relPath = this.normalizeRelPath(rawRel)
        const srcPath = String(item?.srcPath ?? '')
        if (!srcPath || !isAbsolute(srcPath)) throw new Error('源文件路径非法')
        if (!existsSync(srcPath) || !statSync(srcPath).isFile()) throw new Error('源文件不存在')
        const size = statSync(srcPath).size
        if (size > maxBytes) throw new Error(`超过单文件上限（${limits.maxUploadSizeMB} MB）`)

        const hash = createHash('sha256').update(readFileSync(srcPath)).digest('hex')
        const existing = this.store.findDocumentByHash(kbId, hash)
        if (existing) {
          result.skipped.push({
            name: basename(relPath),
            relPath,
            reason: `内容与「${existing.name}」重复，已跳过`
          })
          return
        }

        if (this.store.findDocument(userId, kbId, relPath)) {
          throw new Error('同名文件已存在')
        }

        // 先落盘再写库：磁盘目录以文档 ID 隔离，重命名不影响物理路径
        const docId = randomUUID()
        const destDir = join(this.kbRoot(kbId), docId)
        mkdirSync(destDir, { recursive: true })
        const destPath = join(destDir, basename(relPath))
        copyFileSync(srcPath, destPath)

        const doc = this.store.insertDocument({
          id: docId,
          kbId,
          userId,
          name: basename(relPath),
          type: fileTypeOf(relPath),
          sizeBytes: size,
          relPath,
          storagePath: destPath,
          indexState: 'none',
          contentHash: hash
        })
        result.accepted.push(toDocumentMeta(doc))
      } catch (err) {
        result.failed.push({ name: fallbackName, relPath: rawRel, reason: (err as Error).message })
      }
    })

    this.store.refreshBaseStats(kbId)
    this.store.updateBase(userId, kbId, {})
    return result
  }

  /** 重命名文件或文件夹（文件夹按 relPath 前缀批量改写；磁盘路径不变） */
  renameDocument(
    userId: string,
    kbId: string,
    relPath: string,
    newName: string
  ): { relPath: string; renamed: number } {
    const safeRel = this.normalizeRelPath(relPath)
    const name = this.sanitizeName(newName)
    const docs = this.store.listDocumentsByPrefix(userId, kbId, safeRel)
    if (!docs.length) throw new Error('目标不存在')

    const parentDir = dirname(safeRel)
    const parent = parentDir === '.' ? '' : parentDir
    const isSingleFile = docs.length === 1 && docs[0].relPath === safeRel
    const plan: Array<{ doc: KnowledgeDocumentRow; next: string; nextName: string }> = []

    for (const doc of docs) {
      if (isSingleFile) {
        const next = parent ? `${parent}/${name}` : name
        plan.push({ doc, next, nextName: name })
        continue
      }
      const rest = doc.relPath.slice(safeRel.length).replace(/^\//, '')
      const next = [parent, name, rest].filter(Boolean).join('/')
      plan.push({ doc, next, nextName: doc.name })
    }

    for (const step of plan) {
      if (step.next === step.doc.relPath) continue
      if (this.store.findDocument(userId, kbId, step.next)) {
        throw new Error(`「${step.next}」已存在`)
      }
    }
    for (const step of plan) {
      this.store.updateDocumentPath(step.doc.id, { name: step.nextName, relPath: step.next })
    }
    this.store.updateBase(userId, kbId, {})
    // 返回被重命名节点自身的新路径（文件 = 新文件名；文件夹 = 新的文件夹路径）
    const renamedRelPath = isSingleFile
      ? [parent, name].filter(Boolean).join('/')
      : [parent, name].filter(Boolean).join('/')
    return { relPath: renamedRelPath, renamed: plan.length }
  }

  /** 删除文件或文件夹（文件夹递归删除其下文档与磁盘目录） */
  removeDocuments(userId: string, kbId: string, relPath: string): { removed: number } {
    const safeRel = this.normalizeRelPath(relPath)
    const docs = this.store.listDocumentsByPrefix(userId, kbId, safeRel)
    if (!docs.length) throw new Error('目标不存在')

    const root = resolve(this.kbRoot(kbId))
    for (const doc of docs) {
      // 磁盘目录 = 文档所在目录；越界目录一律不动（防御性校验）
      const dir = resolve(dirname(doc.storagePath || join(root, doc.id)))
      if (dir !== root && dir.startsWith(root + sep)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    this.store.deleteDocuments(docs.map((doc) => doc.id))
    this.store.refreshBaseStats(kbId)
    this.store.updateBase(userId, kbId, {})
    return { removed: docs.length }
  }

  /** 读取文本或原始字节（预览用；路径必须落在知识库目录内） */
  async readDocument(
    userId: string,
    kbId: string,
    relPath: string,
    as: 'text' | 'bytes',
    options: { cursor?: number } = {}
  ): Promise<{
    content?: string
    truncated?: boolean
    /** 续读游标：truncated 为 true 时回传可继续读取后续内容 */
    cursor?: number
    /** 抽取文本总字符数（转换型文档可提前得知） */
    totalChars?: number
    bytes?: Uint8Array
    ext: string
    name: string
  }> {
    const safeRel = this.normalizeRelPath(relPath)
    const doc = this.store.findDocument(userId, kbId, safeRel)
    if (!doc) throw new Error('文件不存在')
    const target = this.resolveInside(this.kbRoot(kbId), doc.storagePath)
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error('文件已丢失')

    const ext = extname(doc.name).toLowerCase().replace(/^\./, '')
    if (as === 'text') {
      // 预览按 PREVIEW_PAGE_CHARS 分页，前端可携带 cursor 续读，直至完整读取整篇文档
      const loaded = await loadFileText(target, ext, {
        cursor: options.cursor,
        maxChars: PREVIEW_PAGE_CHARS
      })
      return {
        content: loaded.content,
        truncated: loaded.truncated,
        cursor: loaded.cursor,
        totalChars: loaded.totalChars,
        ext,
        name: doc.name
      }
    }
    if (statSync(target).size > MAX_BINARY_BYTES) throw new Error('文件过大，暂不支持预览')
    const buffer = await readFile(target)
    return { bytes: new Uint8Array(buffer), ext, name: doc.name }
  }

  /**
   * 读取知识库内的图片原始字节（Markdown 相对路径插图渲染用）
   *
   * 只允许知识库内已登记的图片文件，路径经 normalizeRelPath + containment 校验，
   * 渲染层仅拿到字节，拿不到真实磁盘路径。
   */
  async readImageBytes(
    userId: string,
    kbId: string,
    relPath: string
  ): Promise<{ ext: string; bytes: Uint8Array }> {
    const safeRel = this.normalizeRelPath(relPath)
    const doc = this.store.findDocument(userId, kbId, safeRel)
    if (!doc) throw new Error('图片文件不存在')
    const ext = extname(doc.name).toLowerCase().replace(/^\./, '')
    if (!IMAGE_EXTS.has(ext)) throw new Error('该文件不是支持的图片格式')
    const target = this.resolveInside(this.kbRoot(kbId), doc.storagePath)
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error('图片文件已丢失')
    if (statSync(target).size > MAX_IMAGE_BYTES) throw new Error('图片文件过大，暂不支持预览')
    const buffer = await readFile(target)
    return { ext, bytes: new Uint8Array(buffer) }
  }

  /** 删除某知识库的全部文件（删库时调用；文档记录与目录一并清理） */
  removeKnowledgeBaseFiles(userId: string, kbId: string): number {
    const docs = this.store.listDocuments(userId, kbId)
    const root = resolve(this.kbRoot(kbId))
    for (const doc of docs) {
      const dir = resolve(dirname(doc.storagePath || join(root, doc.id)))
      if (dir !== root && dir.startsWith(root + sep)) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    this.store.deleteDocuments(docs.map((doc) => doc.id))
    // 文档已清空，知识库根目录可整体移除（不存在时忽略）
    rmSync(root, { recursive: true, force: true })
    return docs.length
  }

  /**
   * 知识库文件目录（不存在时创建）。
   *
   * 供「打开文件夹」使用：库内文件实际存放在
   * `<knowledge.directory>/files/<kbId>/<docId>/<原文件名>`。
   */
  resolveBaseDir(userId: string, kbId: string): string {
    if (!this.store.getBase(userId, kbId)) throw new Error('知识库不存在')
    const root = this.kbRoot(kbId)
    mkdirSync(root, { recursive: true })
    return root
  }

  /** 文件所在目录与文件绝对路径（用于在系统文件管理器中定位并选中该文件） */
  resolveDocumentLocation(
    userId: string,
    kbId: string,
    relPath: string
  ): { dir: string; file: string } {
    const safeRel = this.normalizeRelPath(relPath)
    const doc = this.store.findDocument(userId, kbId, safeRel)
    if (!doc) throw new Error('文件不存在')
    const file = this.resolveInside(this.kbRoot(kbId), doc.storagePath)
    if (!existsSync(file)) throw new Error('文件已丢失')
    return { dir: dirname(file), file }
  }

  // ── 内部工具 ──

  /** 相对路径规范化：拒绝绝对路径、越界、空路径；统一 '/' 分隔 */
  normalizeRelPath(input: string): string {
    const raw = String(input ?? '')
      .replace(/\\/g, '/')
      .trim()
    if (!raw) throw new Error('文件路径不能为空')
    if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error('文件路径非法')
    const parts = raw.split('/').filter((part) => part && part !== '.')
    if (!parts.length) throw new Error('文件路径不能为空')
    for (const part of parts) {
      if (part === '..') throw new Error('文件路径非法')
      if (INVALID_NAME_CHARS.test(part)) throw new Error(`名称不能包含非法字符：${part}`)
    }
    return parts.join('/')
  }

  /** 名称校验（与页面弹窗一致：非空、≤60、无斜杠与非法字符） */
  sanitizeName(input: string): string {
    const name = String(input ?? '').trim()
    if (!name) throw new Error('名称不能为空')
    if (name.length > NAME_MAX_LEN) throw new Error(`名称不能超过 ${NAME_MAX_LEN} 个字符`)
    if (name === '.' || name === '..') throw new Error('名称非法')
    if (INVALID_NAME_CHARS.test(name)) throw new Error('名称不能包含 / \\ : * ? " < > | 字符')
    return name
  }

  /** 解析库内路径并做 containment 校验（防路径穿越） */
  private resolveInside(root: string, absPath: string): string {
    const rootResolved = resolve(root)
    const target = resolve(absPath)
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new Error('路径越界')
    }
    return target
  }
}

/** 扩展名 → 展示用类型（PDF / DOCX / 文件） */
function fileTypeOf(relPath: string): string {
  const ext = extname(relPath).toLowerCase().replace(/^\./, '')
  return ext ? ext.toUpperCase() : '文件'
}
