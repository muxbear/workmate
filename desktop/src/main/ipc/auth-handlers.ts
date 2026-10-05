import type { AuthService } from '../services/AuthService'
import type { DataSourceFactory } from '../database/DataSourceFactory'
import type { SessionService } from '../services/SessionService'
import type { OAuth2ClientService } from '../oauth2/OAuth2ClientService'
import type { ISecureStorage } from '../security/secure-storage'
import { oauth2SessionTokenKey } from './oauth2-handlers'
import type { IpcMain } from 'electron'
import { createCommandRegistrar } from './command'

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
  /** 微信扫码授权窗口（主进程实现，见 services/wechatAuthWindow） */
  openWeChatAuth?: (authUrl: string, redirectUri: string) => Promise<{ code?: string; error?: string }>
}

/**
 * 注册认证相关 IPC 通道
 * 鉴权声明均为 none：登录动作先于会话存在；logout 不强制登录态
 * （会话可能已失效，仍要完成本地清理）。
 */
export function registerAuthHandlers(ipc: IpcMain, deps: AuthHandlerDeps): void {
  const registerCommand = createCommandRegistrar(() => deps.session.requireUserId())

  registerCommand<[string, string], unknown>(ipc, 'auth:login-password', {
    auth: 'none',
    parse: ([account, password]) =>
      typeof account === 'string' && typeof password === 'string' ? [account, password] : null,
    execute: async (_ctx, account, password) => {
      const result = await deps.authService.loginByPassword(account, password)
      deps.session.setCurrentUser(result.user.id)
      return result
    }
  })

  registerCommand<[string, string], unknown>(ipc, 'auth:login-sms', {
    auth: 'none',
    parse: ([mobile, code]) =>
      typeof mobile === 'string' && typeof code === 'string' ? [mobile, code] : null,
    execute: async (_ctx, mobile, code) => {
      const result = await deps.authService.loginBySms(mobile, code)
      deps.session.setCurrentUser(result.user.id)
      return result
    }
  })

  registerCommand<[string], null>(ipc, 'auth:send-sms-code', {
    auth: 'none',
    parse: ([mobile]) => (typeof mobile === 'string' ? [mobile] : null),
    execute: async (_ctx, mobile) => {
      await deps.authService.sendSmsCode(mobile)
      return null
    }
  })

  // 微信扫码授权窗口：打开授权页并等待回跳 code（渲染层拿 code 后走 auth:login-wechat 换登录态）
  // 契约是 {code?,error?} 裸形状（见 contracts.ts 的 openWeChatAuth），非 IpcResult 包裹，
  // 不适用 registerCommand；成功/失败由渲染层按 code/error 字段自行分支。
  ipc.handle('auth:wechat-open', async (_event, authUrl?: unknown, redirectUri?: unknown) => {
    if (typeof authUrl !== 'string' || !authUrl || typeof redirectUri !== 'string' || !redirectUri) {
      return { error: '参数错误' }
    }
    if (!deps.openWeChatAuth) {
      return { error: '微信授权未启用' }
    }
    try {
      return await deps.openWeChatAuth(authUrl, redirectUri)
    } catch (err) {
      return { error: (err as Error).message || '微信授权失败' }
    }
  })

  registerCommand<[string], unknown>(ipc, 'auth:login-wechat', {
    auth: 'none',
    parse: ([code]) => (typeof code === 'string' ? [code] : null),
    execute: async (_ctx, code) => {
      const result = await deps.authService.loginByWechat(code)
      deps.session.setCurrentUser(result.user.id)
      return result
    }
  })

  registerCommand<[string], null>(ipc, 'auth:logout', {
    auth: 'none',
    parse: ([account]) => (typeof account === 'string' ? [account] : null),
    execute: async (_ctx, account) => {
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
      return null
    }
  })
}
