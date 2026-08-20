import type { AuthService } from '../services/AuthService'
import type { DataSourceFactory } from '../database/DataSourceFactory'
import type { SessionService } from '../services/SessionService'
import type { OAuth2ClientService } from '../oauth2/OAuth2ClientService'
import type { ISecureStorage } from '../security/secure-storage'
import { oauth2SessionTokenKey } from './oauth2-handlers'
import type { IpcMain } from 'electron'

interface AuthHandlerDeps {
  authService: AuthService
  dataSourceFactory: DataSourceFactory
  session: SessionService
  /** 取消所有正在执行中的 agent 任务（登出前置动作） */
  cancelAllAgents?: () => void
  /** 登出前的附加清理动作（例如隐藏并重置内嵌浏览器）。 */
  onLogout?: () => void
  /** OAuth2 客户端（登出时撤销 refresh token） */
  oauth2Client?: OAuth2ClientService
  secureStorage?: ISecureStorage
}

/** 统一的 IPC 结果包裹：成功返回 data，失败返回 { success:false, error } */
function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

/** 注册认证相关 IPC 通道 */
export function registerAuthHandlers(ipc: IpcMain, deps: AuthHandlerDeps): void {
  ipc.handle('auth:login-password', async (_event, account?: unknown, password?: unknown) => {
    if (typeof account !== 'string' || typeof password !== 'string') {
      return { success: false, error: '参数错误' }
    }
    try {
      const result = await deps.authService.loginByPassword(account, password)
      deps.session.setCurrentUser(result.user.id)
      return ok(result)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipc.handle('auth:login-sms', async (_event, mobile?: unknown, code?: unknown) => {
    if (typeof mobile !== 'string' || typeof code !== 'string') {
      return { success: false, error: '参数错误' }
    }
    try {
      const result = await deps.authService.loginBySms(mobile, code)
      deps.session.setCurrentUser(result.user.id)
      return ok(result)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipc.handle('auth:send-sms-code', async (_event, mobile?: unknown) => {
    if (typeof mobile !== 'string') {
      return { success: false, error: '参数错误' }
    }
    try {
      await deps.authService.sendSmsCode(mobile)
      return ok(null)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipc.handle('auth:login-wechat', async (_event, code?: unknown) => {
    if (typeof code !== 'string') {
      return { success: false, error: '参数错误' }
    }
    try {
      const result = await deps.authService.loginByWechat(code)
      deps.session.setCurrentUser(result.user.id)
      return ok(result)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipc.handle('auth:logout', async (_event, account?: unknown) => {
    if (typeof account !== 'string') {
      return { success: false, error: '参数错误' }
    }
    try {
      // 登出前先停止所有正在执行中的任务（含后台会话）
      deps.cancelAllAgents?.()
      deps.onLogout?.()
      // 撤销 OAuth2 refresh token 并清理本地 token 存储
      const localUserId = deps.session.getCurrentUserId()
      if (localUserId && deps.oauth2Client && deps.secureStorage) {
        const key = oauth2SessionTokenKey(localUserId)
        const token = deps.oauth2Client.loadToken(key)
        if (token) {
          await deps.oauth2Client.revoke(token.refreshToken)
          deps.oauth2Client.deleteToken(key)
        }
      }
      await deps.authService.logout(account)
      deps.session.clear()
      return ok(null)
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
