/**
 * 云知识库 IPC（只读）——把 Web 版的个人库 / 公共库 / 共享给我的同步到桌面端。
 *
 * 与本地知识库的 `knowledge:*` 通道**分开**：本地通道全部同步命中 `index.db`，
 * 这里全是网络 IO 且可能未授权，混在一起会让「本地列表」变成可能挂起/需要授权的操作。
 *
 * **未授权不是失败**：列表类通道返回 `state: 'auth-required'`（仍是 `ok`），
 * 渲染层据此渲染「去授权」按钮；只有参数非法与读取/下载失败才走 `fail`。
 * 这样 `IpcResult.success` 保持"IPC 是否完成"的语义，域状态由载荷表达。
 */

import type { IpcMain } from 'electron'

import type { SessionService } from '../services/SessionService'
import { assertKbId } from '../knowledge/knowledge-schema'
import {
  CloudAuthRequiredError,
  type CloudKbScope,
  type CloudKnowledgeService
} from '../knowledge/CloudKnowledgeService'

export interface CloudKnowledgeHandlerDeps {
  cloudKnowledgeService: CloudKnowledgeService
  session: SessionService
  /** 另存为（复用主进程的保存对话框）；缺省时下载不可用 */
  chooseSavePath?: (defaultName: string) => Promise<string | null>
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof CloudAuthRequiredError
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 列表类通道的统一失败载荷：保持 items/total 等字段齐全，渲染层无需判空 */
function listFailure<T extends { items: unknown[] }>(
  error: unknown,
  empty: T
): { state: 'auth-required' | 'error'; message: string } & T {
  return {
    ...empty,
    state: isAuthRequired(error) ? 'auth-required' : 'error',
    message: errorMessage(error)
  }
}

/** 云分组范围白名单（与后端 scope 取值对齐；all 不暴露给侧栏） */
const CLOUD_SCOPES: readonly CloudKbScope[] = ['personal', 'public']

function asScope(raw: unknown): CloudKbScope {
  if (typeof raw === 'string' && (CLOUD_SCOPES as readonly string[]).includes(raw)) {
    return raw as CloudKbScope
  }
  throw new Error('云知识库范围非法')
}

function asPage(raw: unknown): number {
  if (raw === undefined || raw === null) return 1
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) throw new Error('页码非法')
  return Math.floor(raw)
}

function asPageSize(raw: unknown): number {
  if (raw === undefined || raw === null) return 100
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) throw new Error('每页条数非法')
  return Math.min(100, Math.floor(raw))
}

function asOptionalText(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') throw new Error(`${label}类型错误`)
  return raw
}

/** 校验续读游标：缺省 / null 视为从头读取（与本地知识库同一口径） */
function asCursor(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new Error('续读游标非法')
  return Math.floor(raw)
}

function asBoolean(raw: unknown, label: string): boolean {
  if (typeof raw !== 'boolean') throw new Error(`${label}必须为布尔值`)
  return raw
}

export function registerCloudKnowledgeHandlers(
  ipc: IpcMain,
  deps: CloudKnowledgeHandlerDeps
): void {
  const { cloudKnowledgeService, session, chooseSavePath } = deps

  /** 参数解析：非法就是调用方的编程错误 → 直接 fail（不混进域状态里） */
  function parsedOrFail<T>(parse: () => T): { value: T } | { error: string } {
    try {
      return { value: parse() }
    } catch (err) {
      return { error: errorMessage(err) }
    }
  }

  // ── 状态与列表 ──

  ipc.handle('knowledge-cloud:status', async () => {
    try {
      const userId = session.requireUserId()
      return ok(cloudKnowledgeService.getStatus(userId))
    } catch (err) {
      return fail(errorMessage(err))
    }
  })

  ipc.handle('knowledge-cloud:list', async (_event, raw?: unknown) => {
    const empty = { items: [], total: 0, page: 1, pageSize: 0 }
    const params = (raw ?? {}) as Record<string, unknown>
    const parsed = parsedOrFail(() => ({
      scope: asScope(params.scope),
      page: asPage(params.page),
      pageSize: asPageSize(params.pageSize),
      search: asOptionalText(params.search, '关键字')
    }))
    if ('error' in parsed) return fail(parsed.error)

    try {
      const userId = session.requireUserId()
      const result = await cloudKnowledgeService.listBases(userId, parsed.value.scope, {
        page: parsed.value.page,
        pageSize: parsed.value.pageSize,
        search: parsed.value.search
      })
      return ok({ state: 'ok' as const, message: '', ...result })
    } catch (err) {
      return ok(listFailure(err, empty))
    }
  })

  ipc.handle('knowledge-cloud:invitations', async () => {
    const empty = { items: [] as unknown[] }
    try {
      const userId = session.requireUserId()
      return ok({
        state: 'ok' as const,
        message: '',
        items: await cloudKnowledgeService.listInvitations(userId)
      })
    } catch (err) {
      return ok(listFailure(err, empty))
    }
  })

  ipc.handle('knowledge-cloud:get-kb', async (_event, kbId?: unknown) => {
    const parsed = parsedOrFail(() => assertKbId(kbId))
    if ('error' in parsed) return fail(parsed.error)

    try {
      const userId = session.requireUserId()
      const kb = await cloudKnowledgeService.getBase(userId, parsed.value)
      return ok({ state: 'ok' as const, message: '', kb })
    } catch (err) {
      return ok({
        state: isAuthRequired(err) ? ('auth-required' as const) : ('error' as const),
        message: errorMessage(err),
        kb: null
      })
    }
  })

  ipc.handle('knowledge-cloud:list-docs', async (_event, raw?: unknown) => {
    const empty = { items: [], total: 0, page: 1, pageSize: 0 }
    const params = (raw ?? {}) as Record<string, unknown>
    const parsed = parsedOrFail(() => ({
      kbId: assertKbId(params.kbId),
      page: asPage(params.page),
      pageSize: asPageSize(params.pageSize),
      search: asOptionalText(params.search, '关键字'),
      folder: asOptionalText(params.folder, '目录')
    }))
    if ('error' in parsed) return fail(parsed.error)

    try {
      const userId = session.requireUserId()
      const result = await cloudKnowledgeService.listDocuments(userId, parsed.value.kbId, {
        page: parsed.value.page,
        pageSize: parsed.value.pageSize,
        search: parsed.value.search,
        folder: parsed.value.folder
      })
      return ok({ state: 'ok' as const, message: '', ...result })
    } catch (err) {
      return ok(listFailure(err, empty))
    }
  })

  // ── 参与者操作：接受 / 拒绝分享邀请 ──

  ipc.handle(
    'knowledge-cloud:respond-invitation',
    async (_event, shareId?: unknown, accept?: unknown) => {
      try {
        const userId = session.requireUserId()
        await cloudKnowledgeService.respondInvitation(
          userId,
          assertKbId(shareId),
          asBoolean(accept, 'accept')
        )
        return ok(null)
      } catch (err) {
        return fail(errorMessage(err))
      }
    }
  )

  // ── 读取原文（预览）与另存为 ──

  ipc.handle(
    'knowledge-cloud:read-file',
    async (_event, kbId?: unknown, docId?: unknown, as?: unknown, cursor?: unknown) => {
      try {
        const userId = session.requireUserId()
        if (as !== 'text' && as !== 'bytes') return fail('读取方式非法')
        return ok(
          await cloudKnowledgeService.readDocument(
            userId,
            assertKbId(kbId),
            assertKbId(docId),
            as,
            { cursor: asCursor(cursor) }
          )
        )
      } catch (err) {
        return fail(errorMessage(err))
      }
    }
  )

  ipc.handle(
    'knowledge-cloud:download-doc',
    async (_event, kbId?: unknown, docId?: unknown, suggestedName?: unknown) => {
      try {
        const userId = session.requireUserId()
        if (!chooseSavePath) return fail('当前环境不支持另存为')
        const id = assertKbId(kbId)
        const doc = assertKbId(docId)
        // 文件名只用于对话框默认值；真正落盘的名字由主进程按服务端记录自行净化
        const defaultName = asOptionalText(suggestedName, '文件名') ?? `${doc}.bin`
        const target = await chooseSavePath(defaultName)
        if (!target) return ok({ saved: false })
        await cloudKnowledgeService.saveDocumentAs(userId, id, doc, target)
        return ok({ saved: true, path: target })
      } catch (err) {
        return fail(errorMessage(err))
      }
    }
  )

  /** 登出：清内存缓存（磁盘缓存保留，下次登录仍可命中） */
  ipc.handle('knowledge-cloud:disconnect', async () => {
    cloudKnowledgeService.disconnect()
    return ok(null)
  })
}

export const CLOUD_KNOWLEDGE_CHANNELS = [
  'knowledge-cloud:status',
  'knowledge-cloud:list',
  'knowledge-cloud:invitations',
  'knowledge-cloud:get-kb',
  'knowledge-cloud:list-docs',
  'knowledge-cloud:respond-invitation',
  'knowledge-cloud:read-file',
  'knowledge-cloud:download-doc',
  'knowledge-cloud:disconnect'
] as const
