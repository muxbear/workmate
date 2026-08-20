import { describe, expect, it, vi } from 'vitest'
import { registerOAuth2Handlers } from '../../../src/main/ipc/oauth2-handlers'
import { SessionService } from '../../../src/main/services/SessionService'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'

function deps(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    authService: {} as never,
    oauth2Client: {} as never,
    session: new SessionService(),
    secureStorage: new InMemorySecureStorage(),
    ...overrides
  } as never
}

function createFakeIpcMain(): {
  handle: ReturnType<typeof vi.fn>
  handlers: Map<string, (...args: unknown[]) => unknown>
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    handlers,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return handlers.get(channel)!({} as never, ...args) as T
    }
  }
}

const WEB_USER = { id: 'web-1', nickname: 'Tester', avatar: '' }
const TOKEN = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3600_000,
  scope: 'skill:read',
  webUser: WEB_USER
}

describe('OAuth2 IPC handlers', () => {
  it('注册 auth:login-oauth2 / auth:confirm-oauth2-link / oauth2:status 通道', () => {
    const ipc = createFakeIpcMain()
    registerOAuth2Handlers(ipc as never, deps() as never)
    for (const channel of [
      'auth:login-oauth2',
      'auth:confirm-oauth2-link',
      'oauth2:status'
    ]) {
      expect(ipc.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
  })

  it('login-oauth2：登录成功写入 token 存储与会话', async () => {
    const ipc = createFakeIpcMain()
    const secureStorage = new InMemorySecureStorage()
    const session = new SessionService()
    const oauth2Client = {
      authorize: vi.fn(async () => TOKEN),
      saveToken: vi.fn(),
      loadToken: vi.fn(() => null),
      deleteToken: vi.fn()
    }
    const agentManager = { switchMode: vi.fn().mockResolvedValue(undefined) }
    const authService = {
      loginByOAuth2: vi.fn(async () => ({
        status: 'logged-in',
        user: { id: 'local-1', username: 'web_web-1' }
      }))
    }
    registerOAuth2Handlers(ipc as never, {
      authService,
      oauth2Client,
      session,
      secureStorage,
      agentManager
    } as never)

    const result = await ipc.invoke<{ success: boolean; data: { status: string } }>(
      'auth:login-oauth2'
    )
    expect(result.success).toBe(true)
    expect(result.data.status).toBe('logged-in')
    expect(session.getCurrentUserId()).toBe('local-1')
    expect(session.getWebAccountId()).toBe('web-1')
    expect(oauth2Client.saveToken).toHaveBeenCalledWith(
      'oauth2-session:local-1:tokens',
      TOKEN
    )
    expect(agentManager.switchMode).toHaveBeenCalledWith('cloud')
    expect(secureStorage.get('oauth2-pending:link')).toBeNull()
  })

  it('login-oauth2：cloud Agent 构建失败不阻断登录', async () => {
    const ipc = createFakeIpcMain()
    const secureStorage = new InMemorySecureStorage()
    const session = new SessionService()
    const oauth2Client = {
      authorize: vi.fn(async () => TOKEN),
      saveToken: vi.fn(),
      loadToken: vi.fn(() => null),
      deleteToken: vi.fn()
    }
    const agentManager = {
      switchMode: vi.fn().mockRejectedValue(new Error('postgres unavailable'))
    }
    const authService = {
      loginByOAuth2: vi.fn(async () => ({
        status: 'logged-in',
        user: { id: 'local-1', username: 'web_web-1' }
      }))
    }
    registerOAuth2Handlers(ipc as never, {
      authService,
      oauth2Client,
      session,
      secureStorage,
      agentManager
    } as never)

    const result = await ipc.invoke<{ success: boolean; data: { status: string } }>(
      'auth:login-oauth2'
    )
    expect(result.success).toBe(true)
    expect(result.data.status).toBe('logged-in')
  })

  it('login-oauth2：需要确认时返回 needs-confirmation，不设置会话', async () => {
    const ipc = createFakeIpcMain()
    const secureStorage = new InMemorySecureStorage()
    const session = new SessionService()
    const oauth2Client = {
      authorize: vi.fn(async () => TOKEN),
      saveToken: vi.fn(),
      loadToken: vi.fn(() => null),
      deleteToken: vi.fn()
    }
    const authService = {
      loginByOAuth2: vi.fn(async () => ({
        status: 'needs-confirmation',
        action: 'rebind',
        message: '确认换绑？'
      }))
    }
    registerOAuth2Handlers(ipc as never, {
      authService,
      oauth2Client,
      session,
      secureStorage
    } as never)

    const result = await ipc.invoke<{
      success: boolean
      data: { status: string; action?: string }
    }>('auth:login-oauth2')
    expect(result.data.status).toBe('needs-confirmation')
    expect(result.data.action).toBe('rebind')
    expect(session.getCurrentUserId()).toBeNull()
    // pending 信息保留，供确认分支读取
    expect(secureStorage.get('oauth2-pending:link')).toBeTruthy()
  })

  it('confirm-oauth2-link：确认后完成登录', async () => {
    const ipc = createFakeIpcMain()
    const secureStorage = new InMemorySecureStorage()
    secureStorage.set('oauth2-pending:link', JSON.stringify(TOKEN))
    const session = new SessionService()
    const oauth2Client = {
      authorize: vi.fn(),
      saveToken: vi.fn(),
      loadToken: vi.fn(() => null),
      deleteToken: vi.fn()
    }
    const authService = {
      loginByOAuth2: vi.fn(async () => ({
        status: 'logged-in',
        user: { id: 'local-2', username: 'web_web-1' }
      }))
    }
    registerOAuth2Handlers(ipc as never, {
      authService,
      oauth2Client,
      session,
      secureStorage
    } as never)

    const result = await ipc.invoke<{ success: boolean; data: { status: string } }>(
      'auth:confirm-oauth2-link',
      'switch-identity'
    )
    expect(result.success).toBe(true)
    expect(result.data.status).toBe('logged-in')
    expect(session.getCurrentUserId()).toBe('local-2')
  })

  it('oauth2:status：未登录返回未绑定', async () => {
    const ipc = createFakeIpcMain()
    registerOAuth2Handlers(ipc as never, deps() as never)
    const result = await ipc.invoke<{ success: boolean; data: { linked: boolean } }>(
      'oauth2:status'
    )
    expect(result.success).toBe(true)
    expect(result.data.linked).toBe(false)
  })
})
