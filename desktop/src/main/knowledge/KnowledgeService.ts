import { KnowledgeFileService, toDocumentMeta } from './KnowledgeFileService'
import type { KnowledgeStore } from './KnowledgeStore'
import type {
  KnowledgeBaseRow,
  KnowledgeDocumentMeta,
  KnowledgeImportItem,
  KnowledgeImportResult,
  KnowledgeIndexState,
  KnowledgeKind,
  KnowledgeShareRow,
  KnowledgeStats
} from './types'

/** 知识库名称上限（与页面弹窗一致） */
const NAME_MAX_LEN = 60
/** 描述上限（与页面弹窗一致） */
const DESC_MAX_LEN = 120
const KINDS: readonly KnowledgeKind[] = ['local', 'shared', 'cloud']

export interface CreateKnowledgeBaseInput {
  name: string
  description?: string
  kind?: KnowledgeKind
}

/**
 * 知识库门面服务：知识库 CRUD、文档元信息、统计与共享
 *
 * 职责边界：
 * - 校验（名称/描述/枚举）在门面层完成，主进程为权威；
 * - 文件落盘/读取委托 `KnowledgeFileService`；
 * - 存储委托 `KnowledgeStore`（独立 index.db）；
 * - **不含**索引与检索：切片、向量化、BM25、图谱、问答均由后续阶段实现。
 */
export class KnowledgeService {
  private readonly store: KnowledgeStore
  private readonly files: KnowledgeFileService

  constructor(store: KnowledgeStore, files: KnowledgeFileService) {
    this.store = store
    this.files = files
  }

  // ── 知识库 ──

  listBases(
    userId: string,
    opts: { kind?: KnowledgeKind; keyword?: string } = {}
  ): KnowledgeBaseRow[] {
    return this.store.listBases(userId, opts)
  }

  createBase(userId: string, input: CreateKnowledgeBaseInput): KnowledgeBaseRow {
    const name = this.sanitizeName(input.name)
    if (this.store.findBaseByName(userId, name)) throw new Error(`「${name}」已存在`)
    const description = this.sanitizeDescription(input.description ?? '')
    const kind = this.sanitizeKind(input.kind ?? 'local')
    return this.store.createBase(userId, { name, description, kind })
  }

  updateBase(
    userId: string,
    id: string,
    patch: { name?: string; description?: string }
  ): KnowledgeBaseRow {
    const current = this.store.getBase(userId, id)
    if (!current) throw new Error('知识库不存在')
    const next: { name?: string; description?: string } = {}
    if (patch.name !== undefined) {
      const name = this.sanitizeName(patch.name)
      const duplicated = this.store.findBaseByName(userId, name)
      if (duplicated && duplicated.id !== id) throw new Error(`「${name}」已存在`)
      next.name = name
    }
    if (patch.description !== undefined) {
      next.description = this.sanitizeDescription(patch.description)
    }
    this.store.updateBase(userId, id, next)
    const updated = this.store.getBase(userId, id)
    if (!updated) throw new Error('知识库不存在')
    return updated
  }

  /**
   * 拖拽排序：orderedIds 必须是该分类下全部知识库的 id（顺序可变）。
   *
   * 严格校验集合一致，避免渲染层拿着过期列表乱序写库；不一致时抛错，前端刷新后重试。
   * 返回该用户全部知识库（已按置顶 + 手动顺序排好）。
   */
  reorderBases(userId: string, kind: KnowledgeKind, orderedIds: string[]): KnowledgeBaseRow[] {
    const category = this.sanitizeKind(kind)
    const current = this.store.listBases(userId, { kind: category })
    const currentIds = current.map((row) => row.id)
    const unique = new Set(orderedIds)
    if (
      orderedIds.length !== currentIds.length ||
      unique.size !== orderedIds.length ||
      currentIds.some((id) => !unique.has(id))
    ) {
      throw new Error('知识库列表已变化，请刷新后重新排序')
    }
    this.store.reorderBases(userId, category, orderedIds)
    return this.store.listBases(userId)
  }

  /** 置顶 / 取消置顶：返回该用户全部知识库（已按置顶 + 手动顺序排好） */
  setBasePinned(userId: string, id: string, pinned: boolean): KnowledgeBaseRow[] {
    if (!this.store.getBase(userId, id)) throw new Error('知识库不存在')
    this.store.setBasePinned(userId, id, pinned)
    return this.store.listBases(userId)
  }

  /** 删除知识库：级联清理文档记录、磁盘目录与共享链接（按库配置由 IPC 层一并清理） */
  deleteBase(userId: string, id: string): { removedDocs: number } {
    const base = this.store.getBase(userId, id)
    if (!base) throw new Error('知识库不存在')
    const removedDocs = this.files.removeKnowledgeBaseFiles(userId, id)
    this.store.deleteSharesForTarget(userId, id)
    this.store.deleteBase(userId, id)
    return { removedDocs }
  }

  stats(userId: string): KnowledgeStats {
    return this.store.stats(userId)
  }

  // ── 文档 ──

  listDocuments(userId: string, kbId: string): KnowledgeDocumentMeta[] {
    this.requireBase(userId, kbId)
    return this.store.listDocuments(userId, kbId).map(toDocumentMeta)
  }

  importDocuments(
    userId: string,
    kbId: string,
    items: KnowledgeImportItem[],
    indexState: KnowledgeIndexState = 'none'
  ): KnowledgeImportResult {
    return this.files.importDocuments(userId, kbId, items, indexState)
  }

  renameDocument(
    userId: string,
    kbId: string,
    relPath: string,
    newName: string
  ): { relPath: string; renamed: number } {
    this.requireBase(userId, kbId)
    return this.files.renameDocument(userId, kbId, relPath, newName)
  }

  removeDocument(userId: string, kbId: string, relPath: string): { removed: number } {
    this.requireBase(userId, kbId)
    return this.files.removeDocuments(userId, kbId, relPath)
  }

  readDocument(
    userId: string,
    kbId: string,
    relPath: string,
    as: 'text' | 'bytes',
    options: { cursor?: number } = {}
  ): ReturnType<KnowledgeFileService['readDocument']> {
    this.requireBase(userId, kbId)
    return this.files.readDocument(userId, kbId, relPath, as, options)
  }

  /** 读取知识库内图片原始字节（Markdown 相对路径插图渲染用） */
  readImageBytes(
    userId: string,
    kbId: string,
    relPath: string
  ): ReturnType<KnowledgeFileService['readImageBytes']> {
    this.requireBase(userId, kbId)
    return this.files.readImageBytes(userId, kbId, relPath)
  }

  /** 知识库文件目录（不存在时创建），供「打开文件夹」使用 */
  resolveKnowledgeBaseDir(userId: string, kbId: string): string {
    this.requireBase(userId, kbId)
    return this.files.resolveBaseDir(userId, kbId)
  }

  /** 文件所在目录与文件绝对路径（主进程解析，渲染层不接触路径） */
  resolveDocumentLocation(
    userId: string,
    kbId: string,
    relPath: string
  ): { dir: string; file: string } {
    this.requireBase(userId, kbId)
    return this.files.resolveDocumentLocation(userId, kbId, relPath)
  }

  // ── 共享 ──

  createShare(
    userId: string,
    input: {
      targetKind: KnowledgeShareRow['targetKind']
      targetId: string
      targetName: string
      expiresInDays?: number
    }
  ): KnowledgeShareRow {
    const kinds: readonly KnowledgeShareRow['targetKind'][] = ['library', 'folder', 'file']
    if (!kinds.includes(input.targetKind)) throw new Error('共享对象类型非法')
    const name = String(input.targetName ?? '').trim()
    if (!name) throw new Error('共享对象名称不能为空')
    const expiresAt =
      typeof input.expiresInDays === 'number' && input.expiresInDays > 0
        ? Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000
        : null
    return this.store.insertShare({
      userId,
      targetKind: input.targetKind,
      targetId: String(input.targetId ?? ''),
      targetName: name,
      permission: 'view',
      expiresAt
    })
  }

  listShares(userId: string): KnowledgeShareRow[] {
    return this.store.listShares(userId)
  }

  revokeShare(userId: string, token: string): { revoked: boolean } {
    return { revoked: this.store.revokeShare(userId, String(token ?? '')) > 0 }
  }

  /** 退出/换目录前关闭索引库连接 */
  close(): void {
    this.store.close()
  }

  // ── 内部 ──

  private requireBase(userId: string, kbId: string): KnowledgeBaseRow {
    const base = this.store.getBase(userId, kbId)
    if (!base) throw new Error('知识库不存在')
    return base
  }

  private sanitizeName(input: string): string {
    const name = String(input ?? '').trim()
    if (!name) throw new Error('知识库名称不能为空')
    if (name.length > NAME_MAX_LEN) throw new Error(`名称不能超过 ${NAME_MAX_LEN} 个字符`)
    return name
  }

  private sanitizeDescription(input: string): string {
    const desc = String(input ?? '').trim()
    if (desc.length > DESC_MAX_LEN) throw new Error(`描述不能超过 ${DESC_MAX_LEN} 个字符`)
    return desc
  }

  private sanitizeKind(input: KnowledgeKind): KnowledgeKind {
    if (!KINDS.includes(input)) throw new Error('知识库分组非法')
    return input
  }
}
