import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { KnowledgeSettingsService } from '../knowledge/KnowledgeSettingsService'
import type { KnowledgeService } from '../knowledge/KnowledgeService'
import { assertKbId, assertKbIdList } from '../knowledge/knowledge-schema'
import type { KnowledgeImportItem, KnowledgeIndexState, KnowledgeKind } from '../knowledge/types'

export interface KnowledgeHandlerDeps {
  knowledgeSettingsService: KnowledgeSettingsService
  knowledgeService: KnowledgeService
  session: SessionService
  /**
   * 在系统文件管理器中打开目录（返回错误文案，空串表示成功）。
   * 未注入时「打开文件夹」返回失败，便于单测与无 GUI 环境。
   */
  openDir?: (dir: string) => Promise<string>
  /** 在系统文件管理器中定位并选中文件（优先于 openDir） */
  showItemInFolder?: (file: string) => void
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/** 单批次条目上限（防止单次 IPC 拉爆；真正的批次限制由「知识库设置」决定） */
const MAX_IMPORT_ITEMS = 5000

const KINDS: readonly KnowledgeKind[] = ['local', 'shared', 'cloud']

/** 入参收窄：非空字符串 */
function asText(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${label}不能为空`)
  return raw.trim()
}

/** 入参收窄：可选字符串 */
function asOptionalText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('参数类型错误')
  return raw
}

/** 入参收窄：导入条目数组 */
function asImportItems(raw: unknown): KnowledgeImportItem[] {
  if (!Array.isArray(raw)) throw new Error('items 必须为数组')
  if (raw.length > MAX_IMPORT_ITEMS) throw new Error('单次导入条目过多')
  return raw.map((item) => {
    const row = item as { srcPath?: unknown; relPath?: unknown }
    return {
      srcPath: asText(row?.srcPath, '源文件路径'),
      relPath: asText(row?.relPath, '目标路径')
    }
  })
}

function asIndexState(raw: unknown): KnowledgeIndexState {
  if (raw === undefined || raw === null) return 'none'
  if (raw === 'none' || raw === 'default' || raw === 'custom') return raw
  throw new Error('索引方式非法')
}

/**
 * 注册知识库相关 IPC 通道
 *
 * **用户级数据**：知识库、文档、共享、按库配置都按登录用户隔离，
 * 全部通道先 `session.requireUserId()`；绝对路径只在主进程解析与使用，
 * 渲染层只传 ID 与库内相对路径（与 config:* 的机器级语义不同）。
 *
 * 说明：索引构建与知识库问答/检索尚未实现，这里只提供
 * 知识库管理、文件落盘、文件读取与共享。
 */
export function registerKnowledgeHandlers(ipc: IpcMain, deps: KnowledgeHandlerDeps): void {
  const { knowledgeSettingsService, knowledgeService, session, openDir, showItemInFolder } = deps

  // ── 按库覆盖配置（沿用既有实现）──

  ipc.handle('knowledge:get-kb-settings', async (_event, kbIds?: unknown) => {
    try {
      const userId = session.requireUserId()
      // 省略 kbIds = 拉取该用户全部已配置项；传数组则逐项返回（未配置为 {}）
      const ids = kbIds === undefined ? undefined : assertKbIdList(kbIds)
      return ok(knowledgeSettingsService.getOverridesBatch(userId, ids))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:set-kb-settings', async (_event, kbId?: unknown, overrides?: unknown) => {
    try {
      const userId = session.requireUserId()
      // 传 {} 即该知识库恢复全部跟随全局（条目会被清除）
      return ok(knowledgeSettingsService.setOverrides(userId, assertKbId(kbId), overrides))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  // ── 知识库 ──

  ipc.handle('knowledge:list-kbs', async (_event, options?: unknown) => {
    try {
      const userId = session.requireUserId()
      const raw = (options ?? {}) as { kind?: unknown; keyword?: unknown }
      const kind = raw.kind === undefined ? undefined : (raw.kind as KnowledgeKind)
      if (kind !== undefined && !KINDS.includes(kind)) return fail('知识库分组非法')
      return ok(knowledgeService.listBases(userId, { kind, keyword: asOptionalText(raw.keyword) }))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:create-kb', async (_event, input?: unknown) => {
    try {
      const userId = session.requireUserId()
      const raw = (input ?? {}) as { name?: unknown; description?: unknown; kind?: unknown }
      return ok(
        knowledgeService.createBase(userId, {
          name: asText(raw.name, '知识库名称'),
          description: asOptionalText(raw.description),
          kind: raw.kind === undefined ? 'local' : (raw.kind as KnowledgeKind)
        })
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:update-kb', async (_event, id?: unknown, patch?: unknown) => {
    try {
      const userId = session.requireUserId()
      const raw = (patch ?? {}) as { name?: unknown; description?: unknown }
      return ok(
        knowledgeService.updateBase(userId, assertKbId(id), {
          name: asOptionalText(raw.name),
          description: asOptionalText(raw.description)
        })
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:delete-kb', async (_event, id?: unknown) => {
    try {
      const userId = session.requireUserId()
      const kbId = assertKbId(id)
      const result = knowledgeService.deleteBase(userId, kbId)
      // 知识库已删除：顺手清掉它的按库覆盖配置，避免 kb-settings.json 残留
      knowledgeSettingsService.setOverrides(userId, kbId, {})
      return ok({ ...result, overridesCleared: true })
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:stats', async () => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.stats(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  // ── 文档 ──

  ipc.handle('knowledge:list-docs', async (_event, kbId?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.listDocuments(userId, assertKbId(kbId)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle(
    'knowledge:import',
    async (_event, kbId?: unknown, items?: unknown, indexState?: unknown) => {
      try {
        const userId = session.requireUserId()
        return ok(
          knowledgeService.importDocuments(
            userId,
            assertKbId(kbId),
            asImportItems(items),
            asIndexState(indexState)
          )
        )
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle(
    'knowledge:rename-doc',
    async (_event, kbId?: unknown, relPath?: unknown, newName?: unknown) => {
      try {
        const userId = session.requireUserId()
        return ok(
          knowledgeService.renameDocument(
            userId,
            assertKbId(kbId),
            asText(relPath, '文件路径'),
            asText(newName, '名称')
          )
        )
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle('knowledge:remove-doc', async (_event, kbId?: unknown, relPath?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.removeDocument(userId, assertKbId(kbId), asText(relPath, '文件路径')))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle(
    'knowledge:read-file',
    async (_event, kbId?: unknown, relPath?: unknown, as?: unknown) => {
      try {
        const userId = session.requireUserId()
        if (as !== 'text' && as !== 'bytes') return fail('读取方式非法')
        return ok(
          await knowledgeService.readDocument(
            userId,
            assertKbId(kbId),
            asText(relPath, '文件路径'),
            as
          )
        )
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  // ── 打开文件夹（路径一律由主进程解析）──

  ipc.handle('knowledge:open-dir', async (_event, kbId?: unknown, relPath?: unknown) => {
    try {
      const userId = session.requireUserId()
      const id = assertKbId(kbId)
      if (!openDir) return fail('当前环境不支持打开文件夹')
      // 不传 relPath = 知识库目录；传 = 该文件所在目录（并尽量选中文件）
      if (relPath === undefined || relPath === null || relPath === '') {
        const dir = knowledgeService.resolveKnowledgeBaseDir(userId, id)
        const error = await openDir(dir)
        return error ? fail(error) : ok(null)
      }
      const location = knowledgeService.resolveDocumentLocation(
        userId,
        id,
        asText(relPath, '文件路径')
      )
      if (showItemInFolder) {
        showItemInFolder(location.file)
        return ok(null)
      }
      const error = await openDir(location.dir)
      return error ? fail(error) : ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  // ── 共享 ──

  ipc.handle('knowledge:create-share', async (_event, input?: unknown) => {
    try {
      const userId = session.requireUserId()
      const raw = (input ?? {}) as {
        targetKind?: unknown
        targetId?: unknown
        targetName?: unknown
        expiresInDays?: unknown
      }
      return ok(
        knowledgeService.createShare(userId, {
          targetKind: raw.targetKind as 'library' | 'folder' | 'file',
          targetId: asText(raw.targetId, '共享对象'),
          targetName: asText(raw.targetName, '共享对象名称'),
          expiresInDays:
            typeof raw.expiresInDays === 'number' && Number.isFinite(raw.expiresInDays)
              ? raw.expiresInDays
              : undefined
        })
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:list-shares', async () => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.listShares(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:revoke-share', async (_event, token?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.revokeShare(userId, asText(token, '共享标识')))
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
