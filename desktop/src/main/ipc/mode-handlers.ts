import type { IpcMain } from 'electron'
import type { WorkModeStore } from '../mode/work-mode'
import type { AgentManager } from '../agent/AgentManager'
import type { AuthService } from '../services/AuthService'
import type { SessionService } from '../services/SessionService'
import { createCommandRegistrar } from './command'

interface ModeHandlerDeps {
  modeStore: WorkModeStore
  agentManager: AgentManager
  authService: AuthService
  session: SessionService
}

const VALID_MODES = ['local', 'cloud']

/**
 * 注册工作模式 IPC 通道（登录页即可用，鉴权 none）。
 * mode:set 流程：校验 → 切换 WorkModeStore（R8-3 起为模式单一事实源）→ 清除登录态
 * （不同模式需重新登录）；Agent 构建延迟到登录成功后（见 oauth2-handlers.completeLogin），
 * 避免云端后端未配置时阻塞登录入口。
 */
export function registerModeHandlers(ipc: IpcMain, deps: ModeHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())
  const { modeStore, authService } = deps

  registerCommand<[], 'local' | 'cloud'>(ipc, 'mode:get', {
    auth: 'none',
    execute: () => modeStore.getMode()
  })

  // 会话校验：渲染层路由守卫依赖（localStorage token 可能残留，主进程 session 为权威）。
  // 同时带回权威账号资料——渲染层 localStorage 的 user_info 可能残留上一账号，
  // 仅凭 loggedIn 无法自愈，展示名会错到下次登录（2026-10-05 真实数据走查现场发现）。
  registerCommand<
    [],
    { loggedIn: boolean; user?: { id: string; username: string; mobile?: string } | null }
  >(ipc, 'session:check', {
    auth: 'none',
    execute: async () => {
      const userId = deps.session.getCurrentUserId()
      if (!userId) return { loggedIn: false }
      const user = await authService.getProfileById(userId)
      return { loggedIn: true, user }
    }
  })

  registerCommand<[unknown], 'local' | 'cloud'>(ipc, 'mode:set', {
    auth: 'none',
    execute: async (_ctx, mode) => {
      // 保持既有文案（非「参数错误」，渲染层按此提示）
      if (typeof mode !== 'string' || !(VALID_MODES as string[]).includes(mode)) {
        throw new Error('非法的工作模式')
      }
      const next = mode as 'local' | 'cloud'
      modeStore.setMode(next)
      // 清除登录态（不同模式需重新登录）
      await authService.logout('')
      deps.session.clear()
      return next
    }
  })
}
