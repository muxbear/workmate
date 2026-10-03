import { randomUUID } from 'crypto'
import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { KnowledgeSettingsService } from '../knowledge/KnowledgeSettingsService'
import type { KnowledgeService } from '../knowledge/KnowledgeService'
import type { KnowledgeQaService } from '../knowledge/KnowledgeQaService'
import { assertKbId, assertKbIdList } from '../knowledge/knowledge-schema'
import {
  normalizeIndexSnapshot,
  pickIndexSnapshot,
  toEngineConfig
} from '../knowledge/knowledge-config'
import type {
  KnowledgeImportItem,
  KnowledgeIndexState,
  KnowledgeKind,
  KnowledgeSearchMode
} from '../knowledge/types'

export interface KnowledgeHandlerDeps {
  knowledgeSettingsService: KnowledgeSettingsService
  knowledgeService: KnowledgeService
  /** 知识库问答（2-Step RAG；未注入时 ask 通道返回失败，便于单测） */
  knowledgeQaService?: KnowledgeQaService
  session: SessionService
  /** 全局设置快照（补嵌入/重排端点等全局独占项） */
  getGlobalSettings: () => Record<string, unknown>
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

/** 正在进行的问答（按窗口隔离；同一窗口同时只跑一个） */
const activeAsks = new Map<number, AbortController>()

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

/** 校验续读游标：缺省 / null 视为从头读取 */
function asCursor(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new Error('续读游标非法')
  return Math.floor(raw)
}

function asIndexState(raw: unknown): KnowledgeIndexState {
  if (raw === undefined || raw === null) return 'none'
  if (raw === 'none' || raw === 'default' || raw === 'custom') return raw
  throw new Error('索引方式非法')
}

/** 检索模式（缺省由检索服务按 hybrid 处理） */
function asSearchMode(raw: unknown): KnowledgeSearchMode {
  if (raw === 'hybrid' || raw === 'vector' || raw === 'bm25') return raw
  throw new Error('检索模式非法')
}

/** 可选路径前缀数组（文件/文件夹批量操作） */
function asRelPaths(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('paths 必须为数组')
  if (raw.length > MAX_IMPORT_ITEMS) throw new Error('路径过多')
  return raw.map((item) => asText(item, '文件路径'))
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

  ipc.handle('knowledge:reorder-kbs', async (_event, kind?: unknown, ids?: unknown) => {
    try {
      const userId = session.requireUserId()
      const category = kind as KnowledgeKind
      if (typeof kind !== 'string' || !KINDS.includes(category)) return fail('知识库分类非法')
      return ok(knowledgeService.reorderBases(userId, category, assertKbIdList(ids)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:set-kb-pinned', async (_event, id?: unknown, pinned?: unknown) => {
    try {
      const userId = session.requireUserId()
      if (typeof pinned !== 'boolean') return fail('置顶参数非法')
      return ok(knowledgeService.setBasePinned(userId, assertKbId(id), pinned))
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
    async (_event, kbId?: unknown, items?: unknown, indexState?: unknown, config?: unknown) => {
      try {
        const userId = session.requireUserId()
        const id = assertKbId(kbId)
        const mode = asIndexState(indexState)
        // 配置快照（主进程为权威）：
        // - default：取该库当前生效配置（全局 ← 按库）的 14 个索引项
        // - custom：校验渲染层传来的向导快照（白名单 + 区间/枚举，非法直接拒绝）
        // - none：null（只上传文件）
        let snapshot: string | null = null
        if (mode === 'default') {
          const effective = knowledgeSettingsService.getEffective(userId, id).effective
          snapshot = pickIndexSnapshot(toEngineConfig(effective, deps.getGlobalSettings()))
        } else if (mode === 'custom') {
          snapshot = normalizeIndexSnapshot(config)
          if (!snapshot) throw new Error('自定义索引缺少配置项')
        }
        return ok(knowledgeService.importDocuments(userId, id, asImportItems(items), mode, snapshot))
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  // ── 索引管理（重建 / 重试 / 取消 / 检索）──

  ipc.handle('knowledge:reindex', async (_event, kbId?: unknown, relPaths?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.reindex(userId, assertKbId(kbId), asRelPaths(relPaths)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:retry-doc', async (_event, kbId?: unknown, relPath?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(
        knowledgeService.retryDocument(userId, assertKbId(kbId), asText(relPath, '文件路径'))
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:rebuild-communities', async (_event, kbId?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(await knowledgeService.rebuildCommunities(userId, assertKbId(kbId)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:reextract-graph', async (_event, kbId?: unknown, relPaths?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.reextractGraph(userId, assertKbId(kbId), asRelPaths(relPaths)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:cancel-index', async (_event, kbId?: unknown, relPaths?: unknown) => {
    try {
      const userId = session.requireUserId()
      return ok(knowledgeService.cancelIndex(userId, assertKbId(kbId), asRelPaths(relPaths)))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  // ── 问答（2-Step RAG；结果走 ask-* 事件，与 agent:stream-* 同一约定）──

  ipc.handle(
    'knowledge:ask',
    async (event, kbId?: unknown, question?: unknown, modelName?: unknown) => {
      try {
        const userId = session.requireUserId()
        const id = assertKbId(kbId)
        const text = asText(question, '问题')
        const model = asOptionalText(modelName)?.trim() || undefined
        const qa = deps.knowledgeQaService
        if (!qa) return fail('问答功能不可用')
        // 只记长度不记原文（隐私：设计口径「检索/问答日志不落用户查询内容」）
        console.log(`[main] knowledge:ask kb=${id} questionLen=${text.length}`)

        // 同一窗口同时只允许一个问答：新的提问先取消旧的
        activeAsks.get(event.sender.id)?.abort()
        const controller = new AbortController()
        activeAsks.set(event.sender.id, controller)
        const requestId = randomUUID()

        const send = (channel: string, payload: Record<string, unknown>): void => {
          if (event.sender.isDestroyed()) return
          event.sender.send(channel, { kbId: id, requestId, ...payload })
        }

        void qa
          .ask({
            userId,
            kbId: id,
            question: text,
            modelName: model,
            signal: controller.signal,
            onCitations: (citations) => send('knowledge:ask-citation', { citations }),
            onChunk: (chunk) => send('knowledge:ask-chunk', { text: chunk })
          })
          .then((outcome) => {
            if (outcome.ok) {
              send('knowledge:ask-done', {
                canceled: controller.signal.aborted,
                noRelevantResult: outcome.noRelevantResult === true
              })
            } else {
              send('knowledge:ask-error', { error: outcome.error ?? '问答失败' })
            }
          })
          .catch((err) => send('knowledge:ask-error', { error: (err as Error).message }))
          .finally(() => {
            if (activeAsks.get(event.sender.id) === controller) activeAsks.delete(event.sender.id)
          })

        return ok({ started: true, requestId })
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle('knowledge:cancel-ask', async (event) => {
    try {
      session.requireUserId()
      const controller = activeAsks.get(event.sender.id)
      if (!controller) return ok({ aborted: false })
      controller.abort()
      return ok({ aborted: true })
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('knowledge:search', async (_event, kbId?: unknown, query?: unknown, options?: unknown) => {
    try {
      const userId = session.requireUserId()
      const raw = (options ?? {}) as { topK?: unknown; mode?: unknown }
      const mode = raw.mode === undefined ? undefined : asSearchMode(raw.mode)
      const topK =
        raw.topK === undefined
          ? undefined
          : (() => {
              if (typeof raw.topK !== 'number' || !Number.isFinite(raw.topK)) {
                throw new Error('topK 参数非法')
              }
              return Math.min(100, Math.max(1, Math.floor(raw.topK)))
            })()
      return ok(
        await knowledgeService.search(userId, assertKbId(kbId), asText(query, '检索内容'), {
          topK,
          mode
        })
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

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
    async (_event, kbId?: unknown, relPath?: unknown, as?: unknown, cursor?: unknown) => {
      try {
        const userId = session.requireUserId()
        if (as !== 'text' && as !== 'bytes') return fail('读取方式非法')
        return ok(
          await knowledgeService.readDocument(
            userId,
            assertKbId(kbId),
            asText(relPath, '文件路径'),
            as,
            { cursor: asCursor(cursor) }
          )
        )
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )

  ipc.handle(
    'knowledge:read-image-bytes',
    async (_event, kbId?: unknown, relPath?: unknown) => {
      try {
        const userId = session.requireUserId()
        return ok(
          await knowledgeService.readImageBytes(
            userId,
            assertKbId(kbId),
            asText(relPath, '文件路径')
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
