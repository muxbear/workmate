import type { ConversationStore } from '../agent/ConversationStore'
import type { SessionService } from '../services/SessionService'
import type { IpcMain } from 'electron'

interface ConversationHandlerDeps {
  conversationStore: ConversationStore
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/**
 * 注册会话相关 IPC 通道
 * 会话数据基于 LangGraph checkpointer：列表/消息/删除均由主进程会话注入 userId，
 * thread_id 由 ConversationStore 按 userId 合成（不信任渲染层传参，防越权）
 */
export function registerConversationHandlers(ipc: IpcMain, deps: ConversationHandlerDeps): void {
  const { conversationStore, session } = deps

  ipc.handle('conversation:list', async () => {
    try {
      const userId = session.requireUserId()
      return ok(await conversationStore.listConversations(userId))
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('conversation:get', async (_event, id?: unknown) => {
    if (typeof id !== 'string' || !id) return fail('参数错误')
    try {
      const userId = session.requireUserId()
      const messages = await conversationStore.getMessages(userId, id)
      return ok({ id, messages })
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('conversation:delete', async (_event, id?: unknown) => {
    if (typeof id !== 'string' || !id) return fail('参数错误')
    try {
      const userId = session.requireUserId()
      await conversationStore.deleteConversation(userId, id)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  ipc.handle('conversation:rename', async (_event, id?: unknown, title?: unknown) => {
    if (typeof id !== 'string' || !id || typeof title !== 'string' || !title.trim()) {
      return fail('参数错误')
    }
    try {
      const userId = session.requireUserId()
      await conversationStore.renameConversation(userId, id, title)
      return ok(null)
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  // AI 轮次展示元信息（模型/开始时间/耗时）：实时发送结束由渲染层补写，回显时恢复
  ipc.handle(
    'conversation:save-turn-meta',
    async (_event, id?: unknown, turnIndex?: unknown, meta?: unknown) => {
      if (
        typeof id !== 'string' ||
        !id ||
        typeof turnIndex !== 'number' ||
        !Number.isInteger(turnIndex)
      ) {
        return fail('参数错误')
      }
      if (typeof meta !== 'object' || meta === null) return fail('参数错误')
      const m = meta as Record<string, unknown>
      const model = typeof m.model === 'string' ? m.model : undefined
      const createdAt = typeof m.createdAt === 'number' ? m.createdAt : undefined
      const durationMs = typeof m.durationMs === 'number' ? m.durationMs : undefined
      if (!model && !createdAt && !durationMs) return fail('参数错误')
      try {
        const userId = session.requireUserId()
        conversationStore.saveTurnMeta(userId, id, turnIndex, { model, createdAt, durationMs })
        return ok(null)
      } catch (err) {
        return fail((err as Error).message)
      }
    }
  )
}
