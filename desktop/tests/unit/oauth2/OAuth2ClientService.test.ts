import { describe, expect, it, vi } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { OAuth2ClientService } from '../../../src/main/oauth2/OAuth2ClientService'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'

const API_BASE = 'http://127.0.0.1:8001'

function setup(
  callbackResult: () => Promise<{ code?: string; error?: string }> = async () => ({
    code: 'code-123'
  })
): {
  service: OAuth2ClientService
  secureStorage: InMemorySecureStorage
  openExternal: ReturnType<typeof vi.fn>
  mock: MockAdapter
} {
  const secureStorage = new InMemorySecureStorage()
  const openExternal = vi.fn(async () => {})
  const http = axios.create({ baseURL: API_BASE })
  const mock = new MockAdapter(http)
  const service = new OAuth2ClientService({
    secureStorage,
    openExternal,
    apiBaseUrl: API_BASE,
    clientId: 'ke-work-desktop',
    http,
    callbackServerFactory: () =>
      ({
        start: vi.fn(async () => {}),
        getRedirectUri: vi.fn(() => 'http://127.0.0.1:54821/callback'),
        setExpectedState: vi.fn(),
        waitForCallback: callbackResult,
        stop: vi.fn(async () => {})
      }) as never
  })
  return { service, secureStorage, openExternal, mock }
}

const TOKEN_RESPONSE = {
  access_token: 'at-1',
  token_type: 'Bearer',
  expires_in: 7200,
  refresh_token: 'rt-1',
  scope: 'skill:read',
  user: { id: 'web-1', nickname: 'Tester', avatar: '' }
}

describe('OAuth2ClientService', () => {
  it('authorize：完整授权流程返回标准 token 并保存', async () => {
    const { service, secureStorage, mock } = setup()
    mock.onPost(`${API_BASE}/api/oauth2/authorization-url`).reply(200, {
      code: 0,
      data: {
        authorizeUrl: 'https://web.example/oauth2/authorize?state=test-state',
        state: 'test-state'
      },
      message: 'ok'
    })
    mock.onPost(`${API_BASE}/api/oauth2/token`).reply(200, TOKEN_RESPONSE)

    const token = await service.authorize('skill:read')
    expect(token.accessToken).toBe('at-1')
    expect(token.refreshToken).toBe('rt-1')
    expect(token.webUser.id).toBe('web-1')
    expect(token.expiresAt).toBeGreaterThan(Date.now())

    service.saveToken('oauth2-session:u1:tokens', token)
    const loaded = service.loadToken('oauth2-session:u1:tokens')
    expect(loaded?.accessToken).toBe('at-1')
    expect(loaded?.webUser.id).toBe('web-1')
    expect(secureStorage.get('oauth2-session:u1:tokens')).toBeTruthy()
  })

  it('authorize：用户取消映射为“已取消授权”', async () => {
    const { service, mock } = setup(async () => ({ error: 'access_denied' }))
    mock.onPost(`${API_BASE}/api/oauth2/authorization-url`).reply(200, {
      code: 0,
      data: {
        authorizeUrl: 'https://web.example/oauth2/authorize?state=test-state',
        state: 'test-state'
      },
      message: 'ok'
    })
    mock.onPost(`${API_BASE}/api/oauth2/token`).reply(200, TOKEN_RESPONSE)

    await expect(service.authorize('skill:read')).rejects.toThrow('已取消授权')
  })

  it('ensureValidAccessToken：未过期直接返回，过期自动刷新并保存', async () => {
    const { service, secureStorage, mock } = setup()
    mock.onPost(`${API_BASE}/api/oauth2/refresh`).reply(200, {
      ...TOKEN_RESPONSE,
      access_token: 'at-2',
      refresh_token: 'rt-2',
      expires_in: 3600
    })

    const fresh = {
      accessToken: 'at-fresh',
      refreshToken: 'rt-old',
      expiresAt: Date.now() + 3600_000,
      scope: 'skill:read',
      webUser: { id: 'web-1', nickname: 'Tester' }
    }
    service.saveToken('k', fresh)
    expect(await service.ensureValidAccessToken('k')).toBe('at-fresh')
    expect(mock.history.post).toHaveLength(0)

    const stale = {
      ...fresh,
      accessToken: 'at-stale',
      expiresAt: Date.now() - 1000
    }
    service.saveToken('k2', stale)
    const token = await service.ensureValidAccessToken('k2')
    expect(token).toBe('at-2')
    const saved = service.loadToken('k2')
    expect(saved?.refreshToken).toBe('rt-2')
    expect(secureStorage.get('k2')).toBeTruthy()
  })

  it('revoke：撤销失败不抛错（本地清理不阻断）', async () => {
    const { service, mock } = setup()
    mock.onPost(`${API_BASE}/api/oauth2/revoke`).reply(500, { error: 'server_error' })
    await expect(service.revoke('rt-x')).resolves.toBeUndefined()
  })
})
