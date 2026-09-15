import type { IpcMain } from 'electron'
import type { SessionService } from '../services/SessionService'
import type { KnowledgeSettingsService } from '../knowledge/KnowledgeSettingsService'
import { assertKbId, assertKbIdList } from '../knowledge/knowledge-schema'

export interface KnowledgeHandlerDeps {
  knowledgeSettingsService: KnowledgeSettingsService
  session: SessionService
}

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

/**
 * 注册知识库设置相关 IPC 通道
 *
 * **用户级数据**（对齐知识库表规划的 user_id 维度）：~/.ke-work 是机器级目录、多账号共用，
 * 而知识库 id 目前还是渲染层的固定串（product/design 等）——若不按登录用户隔离，
 * A 用户对某知识库的配置会直接作用到 B 用户。与 config:*（机器级、故意不校验登录态）语义不同。
 *
 * 校验全部交给 knowledge-schema（主进程为权威），非法入参与未登录都收敛为 { success: false }。
 */
export function registerKnowledgeHandlers(ipc: IpcMain, deps: KnowledgeHandlerDeps): void {
  const { knowledgeSettingsService, session } = deps

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
      // 边界处把不可信的 unknown 收窄为字符串（语义校验仍由 service 负责）
      // 传 {} 即该知识库恢复全部跟随全局（条目会被清除）
      return ok(knowledgeSettingsService.setOverrides(userId, assertKbId(kbId), overrides))
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}
