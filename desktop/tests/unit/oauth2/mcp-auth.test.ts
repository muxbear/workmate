import { describe, expect, it, vi } from 'vitest'
import {
  buildPlatformMcpPolicy,
  createAuthedFetch,
  createMcpAuthBinding,
  isPlatformMcpEndpoint,
  McpTokenProvider,
  normalizeOrigin,
  type AuthedFetch,
  type PlatformMcpPolicy
} from '../../../src/main/oauth2/mcpAuth'

const API_BASE = 'http://127.0.0.1:8001'
const KR_SCOPE = 'knowledge:read'

function policy(
  overrides: { apiBaseUrl?: string; mcpPublicBaseUrl?: string } = {}
): PlatformMcpPolicy {
  return buildPlatformMcpPolicy({ apiBaseUrl: API_BASE, ...overrides })
}

/** 记录被调用时的 init，返回一个固定响应 */
function fakeFetch(): { fetch: AuthedFetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: AuthedFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }
  return { fetch, calls }
}

function headerOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('Authorization')
}

describe('isPlatformMcpEndpoint', () => {
  it('accepts the platform backend MCP mounts', () => {
    expect(isPlatformMcpEndpoint('http://127.0.0.1:8001/mcp/kb-http/mcp', policy())).toBe(true)
    expect(isPlatformMcpEndpoint('http://127.0.0.1:8001/mcp/kb/sse', policy())).toBe(true)
  })

  it('accepts loopback aliases of the same port', () => {
    // 后端下发的地址可能写 localhost，而本地 API 基址是 127.0.0.1——两者等价但不能靠 origin 相等判定
    expect(isPlatformMcpEndpoint('http://localhost:8001/mcp/kb/sse', policy())).toBe(true)
    expect(isPlatformMcpEndpoint('http://[::1]:8001/mcp/kb/sse', policy())).toBe(true)
  })

  it('rejects third-party hosts even when the path looks right', () => {
    expect(isPlatformMcpEndpoint('https://third.party.com/mcp/kb-http/mcp', policy())).toBe(false)
  })

  it('rejects non-MCP paths on the platform host', () => {
    expect(isPlatformMcpEndpoint('http://127.0.0.1:8001/api/knowledge-bases', policy())).toBe(false)
  })

  it('rejects a different port on loopback', () => {
    expect(isPlatformMcpEndpoint('http://127.0.0.1:9999/mcp/kb/sse', policy())).toBe(false)
  })

  it('rejects non-http(s) schemes', () => {
    expect(isPlatformMcpEndpoint('file:///mcp/kb/sse', policy())).toBe(false)
    expect(isPlatformMcpEndpoint('ws://127.0.0.1:8001/mcp/kb/sse', policy())).toBe(false)
  })

  it('requires TLS for remote origins', () => {
    // 远端明文会把 token 暴露在网络上：宁可漏注入也不误注入
    const plaintextPolicy = policy({ mcpPublicBaseUrl: 'http://kb.example.com' })
    expect(isPlatformMcpEndpoint('http://kb.example.com/mcp/kb-http/mcp', plaintextPolicy)).toBe(
      false
    )

    const tlsPolicy = policy({ mcpPublicBaseUrl: 'https://kb.example.com' })
    expect(isPlatformMcpEndpoint('https://kb.example.com/mcp/kb-http/mcp', tlsPolicy)).toBe(true)
  })

  it('matches the remote MCP public base url when configured', () => {
    const remotePolicy = policy({ mcpPublicBaseUrl: 'https://kb.example.com/' })
    expect(isPlatformMcpEndpoint('https://kb.example.com/mcp/kb-http/mcp', remotePolicy)).toBe(true)
    expect(isPlatformMcpEndpoint('https://other.example.com/mcp/kb-http/mcp', remotePolicy)).toBe(
      false
    )
  })

  it('rejects malformed urls without throwing', () => {
    expect(isPlatformMcpEndpoint('not-a-url', policy())).toBe(false)
    expect(normalizeOrigin('not-a-url')).toBeNull()
  })
})

describe('createAuthedFetch', () => {
  it('adds the Authorization header and keeps the existing ones', async () => {
    const source = fakeFetch()
    const authed = createAuthedFetch(
      {
        getAccessToken: async () => 'token-1',
        invalidate: () => undefined,
        getLastFailure: () => null
      },
      source.fetch
    )

    await authed('http://127.0.0.1:8001/mcp/kb-http/mcp', {
      headers: { Accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }
    })

    const init = source.calls[0].init
    expect(headerOf(init)).toBe('Bearer token-1')
    // SDK 自己的头不能被覆盖掉，否则 MCP 协议协商会失败
    expect(new Headers(init?.headers).get('mcp-protocol-version')).toBe('2025-06-18')
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json')
  })

  it('degrades to an unauthenticated request when no token is available', async () => {
    const source = fakeFetch()
    const authed = createAuthedFetch(
      {
        getAccessToken: async () => null,
        invalidate: () => undefined,
        getLastFailure: () => null
      },
      source.fetch
    )

    await authed('http://127.0.0.1:8001/mcp/kb-http/mcp')

    expect(headerOf(source.calls[0].init)).toBeNull()
  })

  it('reads the token per request, so a refreshed token is picked up', async () => {
    const source = fakeFetch()
    let current = 'token-old'
    const authed = createAuthedFetch(
      {
        getAccessToken: async () => current,
        invalidate: () => undefined,
        getLastFailure: () => null
      },
      source.fetch
    )

    await authed('http://127.0.0.1:8001/mcp/kb-http/mcp')
    current = 'token-new'
    await authed('http://127.0.0.1:8001/mcp/kb-http/mcp')

    expect(source.calls.map((call) => headerOf(call.init))).toEqual([
      'Bearer token-old',
      'Bearer token-new'
    ])
  })
})

describe('McpTokenProvider', () => {
  it('returns null for a logged-out user without reporting a failure', async () => {
    const authorization = { hasScopes: vi.fn(() => true), tryEnsureAccessToken: vi.fn() }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => null }
    })

    expect(await provider.getAccessToken()).toBeNull()
    expect(provider.getLastFailure()).toBeNull()
    expect(authorization.tryEnsureAccessToken).not.toHaveBeenCalled()
  })

  it('does not trigger interactive authorization when the scope is missing', async () => {
    // 回归守卫：建连发生在智能体构建等后台路径上，弹浏览器会卡住构建
    const authorization = {
      hasScopes: vi.fn(() => false),
      tryEnsureAccessToken: vi.fn(async () => 'never')
    }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => 'local-1' }
    })

    expect(await provider.getAccessToken()).toBeNull()
    expect(authorization.tryEnsureAccessToken).not.toHaveBeenCalled()
    expect(provider.getLastFailure()?.code).toBe('auth-required')
    expect(provider.getLastFailure()?.message).toContain(KR_SCOPE)
  })

  it('returns a token when the scope is granted', async () => {
    const authorization = {
      hasScopes: vi.fn(() => true),
      tryEnsureAccessToken: vi.fn(async () => 'access-1')
    }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => 'local-1' }
    })

    expect(await provider.getAccessToken()).toBe('access-1')
    expect(authorization.tryEnsureAccessToken).toHaveBeenCalledWith('local-1', [KR_SCOPE])
    expect(provider.getLastFailure()).toBeNull()
  })

  it('never throws when the silent token fetch fails', async () => {
    // 静默取 token 失败（refresh 失效等）→ 记 auth-failed 并降级为不带凭据，
    // 既不抛错、也不回头触发交互式授权
    const authorization = {
      hasScopes: vi.fn(() => true),
      tryEnsureAccessToken: vi.fn(async () => null)
    }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => 'local-1' }
    })

    expect(await provider.getAccessToken()).toBeNull()
    expect(provider.getLastFailure()).toMatchObject({ code: 'auth-failed' })
  })

  it('coalesces concurrent calls into one token fetch', async () => {
    const authorization = {
      hasScopes: vi.fn(() => true),
      tryEnsureAccessToken: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'access-1'
      })
    }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => 'local-1' }
    })

    const tokens = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken()
    ])

    expect(tokens).toEqual(['access-1', 'access-1', 'access-1'])
    expect(authorization.tryEnsureAccessToken).toHaveBeenCalledTimes(1)
  })

  it('clears the failure state on invalidate', async () => {
    const authorization = {
      hasScopes: vi.fn(() => false),
      tryEnsureAccessToken: vi.fn(async () => 'access-1')
    }
    const provider = new McpTokenProvider({
      authorization,
      session: { getCurrentUserId: () => 'local-1' }
    })

    await provider.getAccessToken()
    expect(provider.getLastFailure()).not.toBeNull()

    provider.invalidate()
    expect(provider.getLastFailure()).toBeNull()
  })
})

describe('createMcpAuthBinding', () => {
  it('only exposes an authed fetch for platform endpoints', () => {
    const binding = createMcpAuthBinding({
      auth: {
        getAccessToken: async () => 'token-1',
        invalidate: () => undefined,
        getLastFailure: () => null
      },
      policy: policy()
    })

    expect(binding.applies('http://127.0.0.1:8001/mcp/kb-http/mcp')).toBe(true)
    expect(binding.fetchFor('http://127.0.0.1:8001/mcp/kb-http/mcp')).not.toBeNull()
    expect(binding.applies('https://third.party.com/mcp/kb-http/mcp')).toBe(false)
    expect(binding.fetchFor('https://third.party.com/mcp/kb-http/mcp')).toBeNull()
  })

  it('probe surfaces the provider failure reason', async () => {
    const binding = createMcpAuthBinding({
      auth: {
        getAccessToken: async () => null,
        invalidate: () => undefined,
        getLastFailure: () => ({ code: 'auth-required', message: '需要授权' })
      },
      policy: policy()
    })

    expect(await binding.probe()).toBeNull()
    expect(binding.getLastFailure()).toMatchObject({ code: 'auth-required' })
  })
})
