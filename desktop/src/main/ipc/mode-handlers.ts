import type { IpcMain } from 'electron'
import type { WorkModeStore } from '../mode/work-mode'
import type { DataSourceFactory } from '../database/DataSourceFactory'
import type { AgentManager } from '../agent/AgentManager'
import type { AuthService } from '../services/AuthService'
import type { SessionService } from '../services/SessionService'

interface ModeHandlerDeps {
  modeStore: WorkModeStore
  dataSourceFactory: DataSourceFactory
  agentManager: AgentManager
  authService: AuthService
  session: SessionService
}

const VALID_MODES = ['local', 'cloud']

/**
 * 注册工作模式 IPC 通道
 * mode:set 流程：校验 → 构建 Agent（失败回滚）→ 持久化 → 切换工厂 → 通知 → 清除登录态
 */
export function registerModeHandlers(ipc: IpcMain, deps: ModeHandlerDeps): void {
  const { modeStore, dataSourceFactory, authService } = deps

  ipc.handle('mode:get', async () => {
    return { success: true, data: dataSourceFactory.getMode() }
  })

  // 会话校验：渲染层路由守卫依赖（localStorage token 可能残留，主进程 session 为权威）
  ipc.handle('session:check', async () => {
    return { success: true, data: { loggedIn: deps.session.getCurrentUserId() !== null } }
  })

  ipc.handle('mode:set', async (_event, mode?: unknown) => {
    if (typeof mode !== 'string' || !(VALID_MODES as string[]).includes(mode)) {
      return { success: false, error: '非法的工作模式' }
    }
    try {
      // 1. 持久化模式
      modeStore.setMode(mode as 'local' | 'cloud')
      // 2. 切换数据源工厂
      dataSourceFactory.setMode(mode as 'local' | 'cloud')
      // 3. 清除登录态（不同模式需重新登录）
      await authService.logout('')
      deps.session.clear()
      // Agent 构建延迟到登录成功后（见 oauth2-handlers.completeLogin）：
      // 避免云端后端未配置时阻塞登录入口（登录页需先进入 OAuth 面板）
      return { success: true, data: mode }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
