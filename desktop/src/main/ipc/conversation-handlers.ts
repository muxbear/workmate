import type { ConversationStore } from '../agent/ConversationStore'
import type { SessionService } from '../services/SessionService'
import type { IpcMain } from 'electron'
import { createCommandRegistrar } from './command'

interface ConversationHandlerDeps {
  conversationStore: ConversationStore
  session: SessionService
}

type TurnMeta = { model?: string; createdAt?: number; durationMs?: number }

/**
 * 注册会话相关 IPC 通道
 * 会话数据基于 LangGraph checkpointer：列表/消息/删除均由主进程会话注入 userId，
 * thread_id 由 ConversationStore 按 userId 合成（不信任渲染层传参，防越权）
 */
export function registerConversationHandlers(ipc: IpcMain, deps: ConversationHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { conversationStore } = deps

  registerCommand<[], unknown>(ipc, 'conversation:list', {
    auth: 'user',
    execute: async (ctx) => conversationStore.listConversations(ctx.userId as string)
  })

  registerCommand<[string], { id: string; messages: unknown }>(ipc, 'conversation:get', {
    auth: 'user',
    parse: ([id]) => (typeof id === 'string' && id ? [id] : null),
    execute: async (ctx, id) => ({
      id,
      messages: await conversationStore.getMessages(ctx.userId as string, id)
    })
  })

  registerCommand<[string], null>(ipc, 'conversation:delete', {
    auth: 'user',
    parse: ([id]) => (typeof id === 'string' && id ? [id] : null),
    execute: async (ctx, id) => {
      await conversationStore.deleteConversation(ctx.userId as string, id)
      return null
    }
  })

  registerCommand<[string, string], null>(ipc, 'conversation:rename', {
    auth: 'user',
    parse: ([id, title]) =>
      typeof id === 'string' && id && typeof title === 'string' && title.trim() ? [id, title] : null,
    execute: async (ctx, id, title) => {
      await conversationStore.renameConversation(ctx.userId as string, id, title)
      return null
    }
  })

  // AI 轮次展示元信息（模型/开始时间/耗时）：实时发送结束由渲染层补写，回显时恢复
  registerCommand<[string, number, TurnMeta], null>(ipc, 'conversation:save-turn-meta', {
    auth: 'user',
    parse: ([id, turnIndex, meta]) => {
      if (
        typeof id !== 'string' ||
        !id ||
        typeof turnIndex !== 'number' ||
        !Number.isInteger(turnIndex)
      ) {
        return null
      }
      if (typeof meta !== 'object' || meta === null) return null
      const m = meta as Record<string, unknown>
      const parsed: TurnMeta = {
        model: typeof m.model === 'string' ? m.model : undefined,
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : undefined,
        durationMs: typeof m.durationMs === 'number' ? m.durationMs : undefined
      }
      if (!parsed.model && !parsed.createdAt && !parsed.durationMs) return null
      return [id, turnIndex, parsed]
    },
    execute: (ctx, id, turnIndex, parsed) => {
      conversationStore.saveTurnMeta(ctx.userId as string, id, turnIndex, parsed)
      return null
    }
  })
}
