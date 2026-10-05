/**
 * 云知识库 IPC（只读）——把 Web 版的个人库 / 公共库 / 共享给我的同步到桌面端。
 *
 * 与本地知识库的 `knowledge:*` 通道**分开**：本地通道全部同步命中 `index.db`，
 * 这里全是网络 IO 且可能未授权，混在一起会让「本地列表」变成可能挂起/需要授权的操作。
 *
 * **未授权不是失败**：列表类通道返回 `state: 'auth-required'`（仍是 `ok`），
 * 渲染层据此渲染「去授权」按钮；只有参数非法与读取/下载失败才走 `fail`。
 * 这样 `IpcResult.success` 保持"IPC 是否完成"的语义，域状态由载荷表达。
 * 因此列表/详情类通道的鉴权声明为 none（会话校验在 execute 内，与网络错误一起
 * 转成域状态）；respond/read/download 保持「会话校验先于参数校验」的历史顺序。
 */

import type { IpcMain } from 'electron'

import type { SessionService } from '../services/SessionService'
import { assertKbId } from '../knowledge/knowledge-schema'
import {
  CloudAuthRequiredError,
  type CloudKbScope,
  type CloudKnowledgeService
} from '../knowledge/CloudKnowledgeService'
import { createCommandRegistrar } from './command'
import { errorMessage } from './ipc-result'

export interface CloudKnowledgeHandlerDeps {
  cloudKnowledgeService: CloudKnowledgeService
  session: SessionService
  /** 另存为（复用主进程的保存对话框）；缺省时下载不可用 */
  chooseSavePath?: (defaultName: string) => Promise<string | null>
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof CloudAuthRequiredError
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
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { cloudKnowledgeService, chooseSavePath } = deps
  const requireUserId = (): string => deps.session.requireUserId()

  // ── 状态与列表 ──

  registerCommand<[], unknown>(ipc, 'knowledge-cloud:status', {
    auth: 'user',
    execute: (ctx) => cloudKnowledgeService.getStatus(ctx.userId as string)
  })

  registerCommand<[CloudKbScope, number, number, string | undefined], unknown>(
    ipc,
    'knowledge-cloud:list',
    {
      // 参数非法就是调用方的编程错误 → 直接 fail（不混进域状态里）
      parse: ([raw]) => {
        const params = (raw ?? {}) as Record<string, unknown>
        return [
          asScope(params.scope),
          asPage(params.page),
          asPageSize(params.pageSize),
          asOptionalText(params.search, '关键字')
        ]
      },
      // 未授权不是失败：列表类通道返回 state:'auth-required'|'error'（仍是 ok），
      // 与网络错误同一出口，故会话校验在 execute 内
      auth: 'none',
      execute: async (_ctx, scope, page, pageSize, search) => {
        const empty = { items: [], total: 0, page: 1, pageSize: 0 }
        try {
          const userId = requireUserId()
          const result = await cloudKnowledgeService.listBases(userId, scope, {
            page,
            pageSize,
            search
          })
          return { state: 'ok' as const, message: '', ...result }
        } catch (err) {
          return listFailure(err, empty)
        }
      }
    }
  )

  registerCommand<[], unknown>(ipc, 'knowledge-cloud:invitations', {
    auth: 'none',
    execute: async () => {
      const empty = { items: [] as unknown[] }
      try {
        const userId = requireUserId()
        return {
          state: 'ok' as const,
          message: '',
          items: await cloudKnowledgeService.listInvitations(userId)
        }
      } catch (err) {
        return listFailure(err, empty)
      }
    }
  })

  registerCommand<[string], unknown>(ipc, 'knowledge-cloud:get-kb', {
    auth: 'none',
    parse: ([kbId]) => [assertKbId(kbId)],
    execute: async (_ctx, kbId) => {
      try {
        const userId = requireUserId()
        const kb = await cloudKnowledgeService.getBase(userId, kbId)
        return { state: 'ok' as const, message: '', kb }
      } catch (err) {
        return {
          state: isAuthRequired(err) ? ('auth-required' as const) : ('error' as const),
          message: errorMessage(err),
          kb: null
        }
      }
    }
  })

  registerCommand<[string, number, number, string | undefined, string | undefined], unknown>(
    ipc,
    'knowledge-cloud:list-docs',
    {
      parse: ([raw]) => {
        const params = (raw ?? {}) as Record<string, unknown>
        return [
          assertKbId(params.kbId),
          asPage(params.page),
          asPageSize(params.pageSize),
          asOptionalText(params.search, '关键字'),
          asOptionalText(params.folder, '目录')
        ]
      },
      auth: 'none',
      execute: async (_ctx, kbId, page, pageSize, search, folder) => {
        const empty = { items: [], total: 0, page: 1, pageSize: 0 }
        try {
          const userId = requireUserId()
          const result = await cloudKnowledgeService.listDocuments(userId, kbId, {
            page,
            pageSize,
            search,
            folder
          })
          return { state: 'ok' as const, message: '', ...result }
        } catch (err) {
          return listFailure(err, empty)
        }
      }
    }
  )

  // ── 参与者操作：接受 / 拒绝分享邀请 ──

  registerCommand<[unknown, unknown], null>(ipc, 'knowledge-cloud:respond-invitation', {
    auth: 'user',
    // 会话校验先于参数校验（历史顺序：未登录时统一回「未登录」）
    execute: async (ctx, shareId, accept) => {
      await cloudKnowledgeService.respondInvitation(
        ctx.userId as string,
        assertKbId(shareId),
        asBoolean(accept, 'accept')
      )
      return null
    }
  })

  // ── 读取原文（预览）与另存为 ──

  registerCommand<[unknown, unknown, unknown, unknown], unknown>(ipc, 'knowledge-cloud:read-file', {
    auth: 'user',
    // 会话校验先于参数校验（历史顺序：未登录时统一回「未登录」）
    execute: async (ctx, kbId, docId, as, cursor) => {
      if (as !== 'text' && as !== 'bytes') throw new Error('读取方式非法')
      return cloudKnowledgeService.readDocument(
        ctx.userId as string,
        assertKbId(kbId),
        assertKbId(docId),
        as,
        { cursor: asCursor(cursor) }
      )
    }
  })

  registerCommand<[unknown, unknown, unknown], unknown>(ipc, 'knowledge-cloud:download-doc', {
    auth: 'user',
    // 会话校验先于参数校验（历史顺序：未登录时统一回「未登录」）
    execute: async (ctx, kbId, docId, suggestedName) => {
      if (!chooseSavePath) throw new Error('当前环境不支持另存为')
      const id = assertKbId(kbId)
      const doc = assertKbId(docId)
      // 文件名只用于对话框默认值；真正落盘的名字由主进程按服务端记录自行净化
      const defaultName = asOptionalText(suggestedName, '文件名') ?? `${doc}.bin`
      const target = await chooseSavePath(defaultName)
      if (!target) return { saved: false }
      await cloudKnowledgeService.saveDocumentAs(ctx.userId as string, id, doc, target)
      return { saved: true, path: target }
    }
  })

  /** 登出：清内存缓存（磁盘缓存保留，下次登录仍可命中） */
  registerCommand<[], null>(ipc, 'knowledge-cloud:disconnect', {
    auth: 'none',
    execute: () => {
      cloudKnowledgeService.disconnect()
      return null
    }
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
