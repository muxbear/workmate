import { describe, expect, it, vi } from 'vitest'
import {
  OAuth2AuthorizationProvider,
  oauth2SessionTokenKey
} from '../../../src/main/oauth2/OAuth2AuthorizationProvider'
import type { OAuth2ClientService } from '../../../src/main/oauth2/OAuth2ClientService'
import type { OAuth2Token } from '../../../src/main/oauth2/types'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'

const DEFAULT_SCOPES = ['user:read', 'conversation:write', 'skill:read', 'expert:read']

function makeToken(scope: string, overrides: Partial<OAuth2Token> = {}): OAuth2Token {
  return {
    accessToken: `access-${scope}`,
    refreshToken: `refresh-${scope}`,
    expiresAt: Date.now() + 3_600_000,
    scope,
    webUser: { id: 'web-1', nickname: 'demo' },
    ...overrides
  }
}

interface Harness {
  provider: OAuth2AuthorizationProvider
  secureStorage: InMemorySecureStorage
  stored: Map<string, OAuth2Token>
  authorize: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
  saveToken: ReturnType<typeof vi.fn>
  deleteToken: ReturnType<typeof vi.fn>
}

function createHarness(initial: Record<string, OAuth2Token> = {}): Harness {
  const stored = new Map<string, OAuth2Token>(Object.entries(initial))
  const secureStorage = new InMemorySecureStorage()
  const saveToken = vi.fn((key: string, value: OAuth2Token) => {
    stored.set(key, value)
  })
  const deleteToken = vi.fn((key: string) => {
    stored.delete(key)
  })
  // 模拟服务端行为：授权码换取的 token scope 为「已授予 ∪ 本次请求」
  const authorize = vi.fn(async (scope: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const granted = new Set<string>()
    for (const value of stored.values()) {
      for (const item of value.scope.split(' ')) {
        if (item) granted.add(item)
      }
    }
    for (const item of scope.split(' ')) {
      if (item) granted.add(item)
    }
    return makeToken([...granted].join(' '))
  })
  const revoke = vi.fn(async () => undefined)
  const client = {
    loadToken: (key: string) => stored.get(key) ?? null,
    saveToken,
    deleteToken,
    authorize,
    revoke,
    ensureValidAccessToken: async (key: string) => stored.get(key)?.accessToken ?? ''
  }
  const provider = new OAuth2AuthorizationProvider({
    oauth2Client: client as unknown as OAuth2ClientService,
    secureStorage,
    defaultScopes: DEFAULT_SCOPES
  })
  return { provider, secureStorage, stored, authorize, revoke, saveToken, deleteToken }
}

describe('OAuth2AuthorizationProvider', () => {
  it('AP-01: 已授权时静默返回，不打开浏览器', async () => {
    const harness = createHarness({
      [oauth2SessionTokenKey('u1')]: makeToken('skill:read')
    })

    const result = await harness.provider.ensureAuthorization('u1', ['skill:read'])

    expect(result.grantedScopes).toEqual(['skill:read'])
    expect(harness.authorize).not.toHaveBeenCalled()
  })

  it('AP-02: 首次授权请求默认全量集合（一次覆盖全部入口）', async () => {
    const harness = createHarness()

    await harness.provider.ensureAuthorization('u1', ['skill:read'])

    expect(harness.authorize).toHaveBeenCalledTimes(1)
    expect(harness.authorize).toHaveBeenCalledWith(DEFAULT_SCOPES.join(' '))
  })

  it('AP-03: 已有会话时只请求缺失的 scope（增量授权）', async () => {
    const granted = 'user:read conversation:write expert:read'
    const harness = createHarness({
      [oauth2SessionTokenKey('u1')]: makeToken(granted)
    })

    await harness.provider.ensureAuthorization('u1', ['skill:read'])

    expect(harness.authorize).toHaveBeenCalledTimes(1)
    expect(harness.authorize).toHaveBeenCalledWith('skill:read')
  })

  it('AP-04: 并发调用合并为一次授权（单飞锁）', async () => {
    const harness = createHarness()

    const [first, second] = await Promise.all([
      harness.provider.ensureAuthorization('u1', ['skill:read']),
      harness.provider.ensureAuthorization('u1', ['expert:read'])
    ])

    expect(harness.authorize).toHaveBeenCalledTimes(1)
    expect(first.grantedScopes.length).toBeGreaterThan(0)
    expect(second.grantedScopes).toEqual(first.grantedScopes)
  })

  it('AP-05: 历史分功能 token 迁移到统一 key，并在下次授权补齐默认集合', async () => {
    const legacyKey = 'skill-sync:u1:tokens'
    const harness = createHarness({ [legacyKey]: makeToken('skill:read') })

    expect(harness.provider.getGrantedScopes('u1')).toEqual(['skill:read'])
    expect(harness.stored.has(legacyKey)).toBe(false)
    expect(harness.stored.has(oauth2SessionTokenKey('u1'))).toBe(true)

    await harness.provider.ensureAuthorization('u1', ['expert:read'])

    expect(harness.authorize).toHaveBeenCalledWith(DEFAULT_SCOPES.join(' '))
  })

  it('AP-06: 增量授权成功后撤销旧 refresh token', async () => {
    const previous = makeToken('user:read conversation:write expert:read', {
      refreshToken: 'old-refresh'
    })
    const harness = createHarness({ [oauth2SessionTokenKey('u1')]: previous })

    await harness.provider.ensureAuthorization('u1', ['skill:read'])

    expect(harness.revoke).toHaveBeenCalledWith('old-refresh')
    expect(new Set(harness.provider.getGrantedScopes('u1'))).toEqual(new Set(DEFAULT_SCOPES))
  })

  it('AP-07: 断开同步默认只清理本地 token，不撤销服务端授权', async () => {
    const harness = createHarness({
      [oauth2SessionTokenKey('u1')]: makeToken('skill:read')
    })

    await harness.provider.clear('u1')

    expect(harness.revoke).not.toHaveBeenCalled()
    expect(harness.provider.getGrantedScopes('u1')).toEqual([])
  })

  it('AP-08: revokeAndClear 撤销 refresh token 并清空本地会话', async () => {
    const harness = createHarness({
      [oauth2SessionTokenKey('u1')]: makeToken('skill:read')
    })

    await harness.provider.revokeAndClear('u1')

    expect(harness.revoke).toHaveBeenCalledWith('refresh-skill:read')
    expect(harness.provider.getGrantedScopes('u1')).toEqual([])
  })

  it('AP-09: getSnapshot 按所需 scope 判定授权状态', () => {
    const harness = createHarness({
      [oauth2SessionTokenKey('u1')]: makeToken('skill:read')
    })

    const authorized = harness.provider.getSnapshot('u1', ['skill:read'])
    expect(authorized.status).toBe('authorized')
    expect(authorized.missingScopes).toEqual([])
    expect(authorized.webUser?.id).toBe('web-1')

    const unauthorized = harness.provider.getSnapshot('u1', ['skill:read', 'model:read'])
    expect(unauthorized.status).toBe('unauthorized')
    expect(unauthorized.missingScopes).toEqual(['model:read'])
  })
})
