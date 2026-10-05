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
import { createCommandRegistrar } from './command'

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
  /** 选索引库备份的保存位置（系统另存为对话框；取消返回 null） */
  chooseBackupPath?: () => Promise<string | null>
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

/** 多轮历史：数组、最多 5 轮、每段字符串截断（主进程为权威闸门） */
function asHistory(raw: unknown): Array<{ question: string; answer: string }> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('history 必须为数组')
  return raw
    .slice(-5)
    .map((item) => {
      const row = item as { question?: unknown; answer?: unknown }
      return {
        question: String(row?.question ?? '').slice(0, 2000),
        answer: String(row?.answer ?? '').slice(0, 4000)
      }
    })
    .filter((item) => item.question && item.answer)
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
 * 全部通道鉴权声明为 user（注册器统一 requireUserId）；绝对路径只在主进程
 * 解析与使用，渲染层只传 ID 与库内相对路径（与 config:* 的机器级语义不同）。
 *
 * **校验顺序**：本文件的历史顺序是「会话校验先于参数校验」（未登录时即使
 * 参数非法也回「未登录」，knowledge 单测钉死），故不使用注册器的 parse 阶段，
 * 参数收窄保持在 execute 内、鉴权之后。
 */
export function registerKnowledgeHandlers(ipc: IpcMain, deps: KnowledgeHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { knowledgeSettingsService, knowledgeService, openDir, showItemInFolder } = deps

  // ── 按库覆盖配置（沿用既有实现）──

  registerCommand<[unknown], unknown>(ipc, 'knowledge:get-kb-settings', {
    auth: 'user',
    execute: (ctx, kbIds) => {
      // 省略 kbIds = 拉取该用户全部已配置项；传数组则逐项返回（未配置为 {}）
      const ids = kbIds === undefined ? undefined : assertKbIdList(kbIds)
      return knowledgeSettingsService.getOverridesBatch(ctx.userId as string, ids)
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:set-kb-settings', {
    auth: 'user',
    // 传 {} 即该知识库恢复全部跟随全局（条目会被清除）
    execute: (ctx, kbId, overrides) =>
      knowledgeSettingsService.setOverrides(ctx.userId as string, assertKbId(kbId), overrides)
  })

  // ── 知识库 ──

  registerCommand<[unknown], unknown>(ipc, 'knowledge:list-kbs', {
    auth: 'user',
    execute: (ctx, options) => {
      const raw = (options ?? {}) as { kind?: unknown; keyword?: unknown }
      const kind = raw.kind === undefined ? undefined : (raw.kind as KnowledgeKind)
      if (kind !== undefined && !KINDS.includes(kind)) throw new Error('知识库分组非法')
      return knowledgeService.listBases(ctx.userId as string, {
        kind,
        keyword: asOptionalText(raw.keyword)
      })
    }
  })

  registerCommand<[unknown], unknown>(ipc, 'knowledge:create-kb', {
    auth: 'user',
    execute: (ctx, input) => {
      const raw = (input ?? {}) as { name?: unknown; description?: unknown; kind?: unknown }
      return knowledgeService.createBase(ctx.userId as string, {
        name: asText(raw.name, '知识库名称'),
        description: asOptionalText(raw.description),
        kind: raw.kind === undefined ? 'local' : (raw.kind as KnowledgeKind)
      })
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:update-kb', {
    auth: 'user',
    execute: (ctx, id, patch) => {
      const raw = (patch ?? {}) as { name?: unknown; description?: unknown }
      return knowledgeService.updateBase(ctx.userId as string, assertKbId(id), {
        name: asOptionalText(raw.name),
        description: asOptionalText(raw.description)
      })
    }
  })

  registerCommand<[unknown], { overridesCleared: true }>(ipc, 'knowledge:delete-kb', {
    auth: 'user',
    execute: (ctx, id) => {
      const userId = ctx.userId as string
      const kbId = assertKbId(id)
      const result = knowledgeService.deleteBase(userId, kbId)
      // 知识库已删除：顺手清掉它的按库覆盖配置，避免 kb-settings.json 残留
      knowledgeSettingsService.setOverrides(userId, kbId, {})
      return { ...result, overridesCleared: true }
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:reorder-kbs', {
    auth: 'user',
    execute: (ctx, kind, ids) => {
      const category = kind as KnowledgeKind
      if (typeof kind !== 'string' || !KINDS.includes(category)) throw new Error('知识库分类非法')
      return knowledgeService.reorderBases(ctx.userId as string, category, assertKbIdList(ids))
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:set-kb-pinned', {
    auth: 'user',
    execute: (ctx, id, pinned) => {
      if (typeof pinned !== 'boolean') throw new Error('置顶参数非法')
      return knowledgeService.setBasePinned(ctx.userId as string, assertKbId(id), pinned)
    }
  })

  registerCommand<[], unknown>(ipc, 'knowledge:stats', {
    auth: 'user',
    execute: (ctx) => knowledgeService.stats(ctx.userId as string)
  })

  // ── 文档 ──

  registerCommand<[unknown], unknown>(ipc, 'knowledge:list-docs', {
    auth: 'user',
    execute: (ctx, kbId) => knowledgeService.listDocuments(ctx.userId as string, assertKbId(kbId))
  })

  registerCommand<[unknown, unknown, unknown, unknown], unknown>(ipc, 'knowledge:import', {
    auth: 'user',
    execute: (ctx, kbId, items, indexState, config) => {
      const userId = ctx.userId as string
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
      return knowledgeService.importDocuments(userId, id, asImportItems(items), mode, snapshot)
    }
  })

  // ── 索引管理（重建 / 重试 / 取消 / 检索）──

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:reindex', {
    auth: 'user',
    execute: (ctx, kbId, relPaths) =>
      knowledgeService.reindex(ctx.userId as string, assertKbId(kbId), asRelPaths(relPaths))
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:retry-doc', {
    auth: 'user',
    execute: (ctx, kbId, relPath) =>
      knowledgeService.retryDocument(
        ctx.userId as string,
        assertKbId(kbId),
        asText(relPath, '文件路径')
      )
  })

  registerCommand<[], unknown>(ipc, 'knowledge:backup-index', {
    auth: 'user',
    execute: async (ctx) => {
      if (!deps.chooseBackupPath) throw new Error('当前环境不支持选择保存位置')
      const dest = await deps.chooseBackupPath()
      if (!dest) return { canceled: true }
      const result = knowledgeService.backupIndex(ctx.userId as string, dest)
      return { canceled: false, path: dest, sizeBytes: result.sizeBytes }
    }
  })

  registerCommand<[unknown], unknown>(ipc, 'knowledge:rebuild-communities', {
    auth: 'user',
    execute: (ctx, kbId) =>
      knowledgeService.rebuildCommunities(ctx.userId as string, assertKbId(kbId))
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:reextract-graph', {
    auth: 'user',
    execute: (ctx, kbId, relPaths) =>
      knowledgeService.reextractGraph(ctx.userId as string, assertKbId(kbId), asRelPaths(relPaths))
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:cancel-index', {
    auth: 'user',
    execute: (ctx, kbId, relPaths) =>
      knowledgeService.cancelIndex(ctx.userId as string, assertKbId(kbId), asRelPaths(relPaths))
  })

  // ── 问答（2-Step RAG；结果走 ask-* 事件，与 agent:stream-* 同一约定）──

  registerCommand<[unknown, unknown, unknown, unknown], { started: true; requestId: string }>(
    ipc,
    'knowledge:ask',
    {
      auth: 'user',
      execute: (ctx, kbId, question, modelName, history) => {
        const userId = ctx.userId as string
        const event = ctx.event
        const id = assertKbId(kbId)
        const text = asText(question, '问题')
        const model = asOptionalText(modelName)?.trim() || undefined
        const qa = deps.knowledgeQaService
        if (!qa) throw new Error('问答功能不可用')
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
            history: asHistory(history),
            signal: controller.signal,
            onCitations: (citations) => send('knowledge:ask-citation', { citations }),
            onChunk: (chunk) => send('knowledge:ask-chunk', { text: chunk })
          })
          .then((outcome) => {
            if (outcome.ok) {
              send('knowledge:ask-done', {
                canceled: controller.signal.aborted,
                noRelevantResult: outcome.noRelevantResult === true,
                ...(outcome.invalidCitations?.length
                  ? { invalidCitations: outcome.invalidCitations }
                  : {})
              })
            } else {
              send('knowledge:ask-error', { error: outcome.error ?? '问答失败' })
            }
          })
          .catch((err) => send('knowledge:ask-error', { error: (err as Error).message }))
          .finally(() => {
            if (activeAsks.get(event.sender.id) === controller) activeAsks.delete(event.sender.id)
          })

        return { started: true as const, requestId }
      }
    }
  )

  registerCommand<[], { aborted: boolean }>(ipc, 'knowledge:cancel-ask', {
    auth: 'user',
    execute: (ctx) => {
      const controller = activeAsks.get(ctx.event.sender.id)
      if (!controller) return { aborted: false }
      controller.abort()
      return { aborted: true }
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:graph-view', {
    auth: 'user',
    execute: (ctx, kbId, options) => {
      const raw = (options ?? {}) as { limit?: unknown }
      let limit: number | undefined
      if (raw.limit !== undefined) {
        if (typeof raw.limit !== 'number' || !Number.isFinite(raw.limit)) {
          throw new Error('limit 参数非法')
        }
        limit = Math.floor(raw.limit)
      }
      return knowledgeService.graphView(ctx.userId as string, assertKbId(kbId), { limit })
    }
  })

  registerCommand<[unknown, unknown, unknown], unknown>(ipc, 'knowledge:search', {
    auth: 'user',
    execute: async (ctx, kbId, query, options) => {
      const raw = (options ?? {}) as { topK?: unknown; mode?: unknown; debug?: unknown }
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
      if (raw.debug !== undefined && typeof raw.debug !== 'boolean') {
        throw new Error('debug 参数非法')
      }
      return knowledgeService.search(ctx.userId as string, assertKbId(kbId), asText(query, '检索内容'), {
        topK,
        mode,
        debug: raw.debug
      })
    }
  })

  registerCommand<[unknown, unknown, unknown], unknown>(ipc, 'knowledge:rename-doc', {
    auth: 'user',
    execute: (ctx, kbId, relPath, newName) =>
      knowledgeService.renameDocument(
        ctx.userId as string,
        assertKbId(kbId),
        asText(relPath, '文件路径'),
        asText(newName, '名称')
      )
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:remove-doc', {
    auth: 'user',
    execute: (ctx, kbId, relPath) =>
      knowledgeService.removeDocument(
        ctx.userId as string,
        assertKbId(kbId),
        asText(relPath, '文件路径')
      )
  })

  registerCommand<[unknown, unknown, unknown, unknown], unknown>(ipc, 'knowledge:read-file', {
    auth: 'user',
    execute: async (ctx, kbId, relPath, as, cursor) => {
      if (as !== 'text' && as !== 'bytes') throw new Error('读取方式非法')
      return knowledgeService.readDocument(
        ctx.userId as string,
        assertKbId(kbId),
        asText(relPath, '文件路径'),
        as,
        { cursor: asCursor(cursor) }
      )
    }
  })

  registerCommand<[unknown, unknown], unknown>(ipc, 'knowledge:read-image-bytes', {
    auth: 'user',
    execute: (ctx, kbId, relPath) =>
      knowledgeService.readImageBytes(
        ctx.userId as string,
        assertKbId(kbId),
        asText(relPath, '文件路径')
      )
  })

  // ── 打开文件夹（路径一律由主进程解析）──

  registerCommand<[unknown, unknown], null>(ipc, 'knowledge:open-dir', {
    auth: 'user',
    execute: async (ctx, kbId, relPath) => {
      const userId = ctx.userId as string
      const id = assertKbId(kbId)
      if (!openDir) throw new Error('当前环境不支持打开文件夹')
      // 不传 relPath = 知识库目录；传 = 该文件所在目录（并尽量选中文件）
      if (relPath === undefined || relPath === null || relPath === '') {
        const dir = knowledgeService.resolveKnowledgeBaseDir(userId, id)
        const error = await openDir(dir)
        if (error) throw new Error(error)
        return null
      }
      const location = knowledgeService.resolveDocumentLocation(
        userId,
        id,
        asText(relPath, '文件路径')
      )
      if (showItemInFolder) {
        showItemInFolder(location.file)
        return null
      }
      const error = await openDir(location.dir)
      if (error) throw new Error(error)
      return null
    }
  })

  // ── 共享 ──

  registerCommand<[unknown], unknown>(ipc, 'knowledge:create-share', {
    auth: 'user',
    execute: (ctx, input) => {
      const raw = (input ?? {}) as {
        targetKind?: unknown
        targetId?: unknown
        targetName?: unknown
        expiresInDays?: unknown
      }
      return knowledgeService.createShare(ctx.userId as string, {
        targetKind: raw.targetKind as 'library' | 'folder' | 'file',
        targetId: asText(raw.targetId, '共享对象'),
        targetName: asText(raw.targetName, '共享对象名称'),
        expiresInDays:
          typeof raw.expiresInDays === 'number' && Number.isFinite(raw.expiresInDays)
            ? raw.expiresInDays
            : undefined
      })
    }
  })

  registerCommand<[], unknown>(ipc, 'knowledge:list-shares', {
    auth: 'user',
    execute: (ctx) => knowledgeService.listShares(ctx.userId as string)
  })

  registerCommand<[unknown], unknown>(ipc, 'knowledge:revoke-share', {
    auth: 'user',
    execute: (ctx, token) => knowledgeService.revokeShare(ctx.userId as string, asText(token, '共享标识'))
  })
}
