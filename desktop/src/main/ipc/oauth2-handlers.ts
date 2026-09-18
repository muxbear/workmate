import type { IpcMain } from 'electron'
import type { AuthService } from '../services/AuthService'
import type { SessionService } from '../services/SessionService'
import type { OAuth2ClientService } from '../oauth2/OAuth2ClientService'
import {
  OAuth2AuthorizationProvider,
  oauth2SessionTokenKey,
  toWebUser
} from '../oauth2/OAuth2AuthorizationProvider'
import { DESKTOP_DEFAULT_SCOPES, DESKTOP_SCOPE_CATALOG } from '../oauth2/scopes'
import type { OAuth2Token } from '../oauth2/types'
import type { ISecureStorage } from '../security/secure-storage'
import type { AgentManager } from '../agent/AgentManager'

interface OAuth2HandlerDeps {
  authService: AuthService
  oauth2Client: OAuth2ClientService
  /** 统一 OAuth2 授权提供者：登录成功后写入统一会话 token */
  authorization: OAuth2AuthorizationProvider
  session: SessionService
  secureStorage: ISecureStorage
  /** Agent 管理器：OAuth2 登录成功后重建 cloud Agent（构建失败不阻断登录） */
  agentManager?: AgentManager
}

/** 云端登录申请的 scope：桌面默认权限集合，一次授权覆盖专家 / 技能 / 模型等全部入口 */
export const OAUTH2_LOGIN_SCOPE = DESKTOP_DEFAULT_SCOPES.join(' ')

export const OAUTH2_SESSION_TOKEN_PREFIX = 'oauth2-session:'

export { oauth2SessionTokenKey }

const PENDING_LINK_KEY = 'oauth2-pending:link'

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

function fail(error: string): { success: false; error: string } {
  return { success: false, error }
}

function parseToken(raw: string | null): OAuth2Token | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuth2Token
  } catch {
    return null
  }
}

/** 注册 OAuth2 登录 IPC 通道。 */
export function registerOAuth2Handlers(ipc: IpcMain, deps: OAuth2HandlerDeps): void {
  const { authService, oauth2Client, authorization, session, secureStorage } = deps

  ipc.handle('auth:login-oauth2', async () => {
    try {
      // 1. 完整 OAuth2 授权（PKCE → 浏览器 → 回跳 → 换 token）
      const token = await oauth2Client.authorize(OAUTH2_LOGIN_SCOPE)
      // 2. 暂存 pending 链接信息（确认分支从 secureStorage 读取，防渲染层伪造）
      secureStorage.set(PENDING_LINK_KEY, JSON.stringify(token))
      const currentUserId = session.getCurrentUserId()
      const result = await authService.loginByOAuth2(token.webUser, token, currentUserId, false)

      if (result.status === 'needs-confirmation') {
        return ok({
          status: 'needs-confirmation',
          action: result.action,
          message: result.message,
          webUser: token.webUser
        })
      }

      await completeLogin(token, result.user!, session, authorization, secureStorage)
      await ensureCloudAgent(deps.agentManager)
      return ok({
        status: 'logged-in',
        user: result.user,
        webUser: token.webUser,
        grantedScopes: authorization.getGrantedScopes(result.user!.id)
      })
    } catch (err) {
      secureStorage.delete(PENDING_LINK_KEY)
      return fail((err as Error).message || 'OAuth2 登录失败')
    }
  })

  ipc.handle('auth:confirm-oauth2-link', async (_event, action?: unknown) => {
    try {
      const token = parseToken(secureStorage.get(PENDING_LINK_KEY))
      if (!token) {
        return fail('授权状态已失效，请重新登录')
      }
      const currentUserId = session.getCurrentUserId()

      // 换绑：先撤销旧 Web 账号的 refresh token 并清理旧 token 存储
      if (action === 'rebind' && currentUserId) {
        await authorization.revokeAndClear(currentUserId)
      }

      const result = await authService.loginByOAuth2(token.webUser, token, currentUserId, true)
      if (result.status !== 'logged-in' || !result.user) {
        return fail(result.message || '登录失败')
      }

      await completeLogin(token, result.user, session, authorization, secureStorage)
      await ensureCloudAgent(deps.agentManager)
      return ok({
        status: 'logged-in',
        user: result.user,
        webUser: token.webUser,
        grantedScopes: authorization.getGrantedScopes(result.user.id)
      })
    } catch (err) {
      return fail((err as Error).message || '确认登录失败')
    }
  })

  ipc.handle('oauth2:status', async () => {
    try {
      const localUserId = session.getCurrentUserId()
      if (!localUserId) {
        return ok({ linked: false, webAccountId: null, grantedScopes: [] })
      }
      const status = await authService.getOAuth2Status(localUserId)
      const token = oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))
      return ok({
        linked: status.linked,
        webAccountId: status.webAccountId,
        webUser: token?.webUser ?? null,
        grantedScopes: authorization.getGrantedScopes(localUserId)
      })
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 授权管理：scope 目录 + 当前授予状态 */
  ipc.handle('oauth2:scope-catalog', async () => {
    try {
      const localUserId = session.getCurrentUserId()
      const granted = new Set(localUserId ? authorization.getGrantedScopes(localUserId) : [])
      return ok(
        DESKTOP_SCOPE_CATALOG.map((scope) => ({
          ...scope,
          granted: granted.has(scope.key)
        }))
      )
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 按需授权（缺省请求桌面默认集合）；已授权时静默返回，不打开浏览器 */
  ipc.handle('oauth2:authorize', async (_event, scopes?: unknown) => {
    try {
      const localUserId = session.requireUserId()
      const required = Array.isArray(scopes)
        ? scopes.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [...DESKTOP_DEFAULT_SCOPES]
      const result = await authorization.ensureAuthorization(localUserId, required, {
        reason: 'manual'
      })
      return ok({
        webUser: toWebUser(authorization.getWebUser(localUserId)),
        grantedScopes: result.grantedScopes
      })
    } catch (err) {
      return fail((err as Error).message)
    }
  })

  /** 撤销指定 scope 或整份授权（服务端 consent + refresh token，本地同步清理） */
  ipc.handle('oauth2:revoke', async (_event, scopes?: unknown) => {
    try {
      const localUserId = session.requireUserId()
      const scopeList = Array.isArray(scopes)
        ? scopes.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined
      try {
        const accessToken = await oauth2Client.ensureValidAccessToken(
          oauth2SessionTokenKey(localUserId)
        )
        await oauth2Client.revokeConsent(accessToken, scopeList)
      } catch (err) {
        // 服务端撤销失败不阻断本地清理（本地 token 会在下次同步时重新授权）
        console.warn('[oauth2] revoke consent on server failed:', err)
      }
      // 决策 D3：关闭单项后本地 token 立即收缩，其余能力不受影响；
      // 整份撤销则清空本地会话。
      const grantedScopes = scopeList ? authorization.shrinkScopes(localUserId, scopeList) : []
      if (!scopeList) {
        await authorization.clear(localUserId)
      }
      return ok({ grantedScopes })
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}

async function completeLogin(
  token: OAuth2Token,
  user: { id: string; username: string },
  session: SessionService,
  authorization: OAuth2AuthorizationProvider,
  secureStorage: ISecureStorage
): Promise<void> {
  authorization.saveSessionToken(user.id, token)
  secureStorage.delete(PENDING_LINK_KEY)
  session.setCurrentUser(user.id, token.webUser.id)
}

/**
 * OAuth2 登录仅在云端模式下发生：登录成功后确保 cloud Agent 已构建。
 * 云端后端未配置时构建失败只告警，登录流程不受影响（发消息时 ready() 会给出明确错误）。
 */
async function ensureCloudAgent(agentManager?: AgentManager): Promise<void> {
  if (!agentManager) return
  try {
    await agentManager.switchMode('cloud')
  } catch (err) {
    console.warn('[oauth2] cloud agent build failed after login:', err)
  }
}
