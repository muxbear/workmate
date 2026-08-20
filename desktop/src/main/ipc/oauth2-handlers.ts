import type { IpcMain } from 'electron'
import type { AuthService } from '../services/AuthService'
import type { SessionService } from '../services/SessionService'
import type { OAuth2ClientService } from '../oauth2/OAuth2ClientService'
import type { OAuth2Token } from '../oauth2/types'
import type { ISecureStorage } from '../security/secure-storage'
import type { AgentManager } from '../agent/AgentManager'

interface OAuth2HandlerDeps {
  authService: AuthService
  oauth2Client: OAuth2ClientService
  session: SessionService
  secureStorage: ISecureStorage
  /** Agent 管理器：OAuth2 登录成功后重建 cloud Agent（构建失败不阻断登录） */
  agentManager?: AgentManager
}

/** 云端登录申请的 scope（与 ke-work-desktop 客户端注册保持一致） */
export const OAUTH2_LOGIN_SCOPE =
  'skill:read user:read agent:read conversation:read conversation:write workspace:read'

export const OAUTH2_SESSION_TOKEN_PREFIX = 'oauth2-session:'
const PENDING_LINK_KEY = 'oauth2-pending:link'

export function oauth2SessionTokenKey(localUserId: string): string {
  return `${OAUTH2_SESSION_TOKEN_PREFIX}${localUserId}:tokens`
}

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
  const { authService, oauth2Client, session, secureStorage } = deps

  ipc.handle('auth:login-oauth2', async () => {
    try {
      // 1. 完整 OAuth2 授权（PKCE → 浏览器 → 回跳 → 换 token）
      const token = await oauth2Client.authorize(OAUTH2_LOGIN_SCOPE)
      // 2. 暂存 pending 链接信息（确认分支从 secureStorage 读取，防渲染层伪造）
      secureStorage.set(PENDING_LINK_KEY, JSON.stringify(token))
      const currentUserId = session.getCurrentUserId()
      const result = await authService.loginByOAuth2(
        token.webUser,
        token,
        currentUserId,
        false
      )

      if (result.status === 'needs-confirmation') {
        return ok({
          status: 'needs-confirmation',
          action: result.action,
          message: result.message,
          webUser: token.webUser
        })
      }

      await completeLogin(token, result.user!, session, oauth2Client, secureStorage)
      await ensureCloudAgent(deps.agentManager)
      return ok({
        status: 'logged-in',
        user: result.user,
        webUser: token.webUser
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
        const oldKey = oauth2SessionTokenKey(currentUserId)
        const oldToken = oauth2Client.loadToken(oldKey)
        if (oldToken) {
          await oauth2Client.revoke(oldToken.refreshToken)
          oauth2Client.deleteToken(oldKey)
        }
      }

      const result = await authService.loginByOAuth2(
        token.webUser,
        token,
        currentUserId,
        true
      )
      if (result.status !== 'logged-in' || !result.user) {
        return fail(result.message || '登录失败')
      }

      await completeLogin(token, result.user, session, oauth2Client, secureStorage)
      await ensureCloudAgent(deps.agentManager)
      return ok({
        status: 'logged-in',
        user: result.user,
        webUser: token.webUser
      })
    } catch (err) {
      return fail((err as Error).message || '确认登录失败')
    }
  })

  ipc.handle('oauth2:status', async () => {
    try {
      const localUserId = session.getCurrentUserId()
      if (!localUserId) {
        return ok({ linked: false, webAccountId: null })
      }
      const status = await authService.getOAuth2Status(localUserId)
      const token = oauth2Client.loadToken(oauth2SessionTokenKey(localUserId))
      return ok({
        linked: status.linked,
        webAccountId: status.webAccountId,
        webUser: token?.webUser ?? null
      })
    } catch (err) {
      return fail((err as Error).message)
    }
  })
}

async function completeLogin(
  token: OAuth2Token,
  user: { id: string; username: string },
  session: SessionService,
  oauth2Client: OAuth2ClientService,
  secureStorage: ISecureStorage
): Promise<void> {
  oauth2Client.saveToken(oauth2SessionTokenKey(user.id), token)
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
