/**
 * Mock OAuth2 授权服务（E2E 用）。
 *
 * 模拟 Web 后端 OAuth2 端点 + 授权页：
 * - POST /api/oauth2/authorization-url → 返回带标准参数的授权页 URL（state 固定）
 * - GET  /oauth2/authorize → 自动“同意”，302 回跳 redirect_uri?code=...&state=...
 * - POST /api/oauth2/token / refresh / revoke → 标准响应
 * - POST /api/oauth2/consents/revoke → 统一授权撤销端点（空响应）
 * - GET  /api/expert-sync/list、/api/skill/list、/api/model-sync/list → 最小可用数据
 *
 * 统一授权用例所需能力：
 * - setMockDeniedScopes：模拟用户在授权页关闭了某些权限，授权码换取的 token 只带剩余 scope；
 * - getMockStats：记录授权 URL 请求的 scope 列表与 token 交换次数，
 *   用于断言“默认全开只授权一次”“关闭后仅对应功能发起增量授权”。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { URLSearchParams } from 'url'

const MOCK_STATE = 'mock-state-123'
const MOCK_USER = { id: 'mock-web-user-1', nickname: '测试用户', avatar: '' }

let server: ReturnType<typeof createServer> | null = null
let currentPort = 8001

/** 模拟用户在授权页关闭的 scope */
let deniedScopes: string[] = []
/** 最近一次授权请求的 scope（授权码换取 token 时使用） */
let pendingScopes: string[] = []
/** 已签发的 token scope */
let grantedScopes: string[] = []
/** 授权 URL 请求记录（每次打开授权页一条） */
let authorizationRequests: string[] = []
/** token 交换次数（每次完成授权流程 +1） */
let tokenRequests = 0

/** 设置模拟“用户关闭的权限”（授权页开关关掉的效果） */
export function setMockDeniedScopes(scopes: string[]): void {
  deniedScopes = [...scopes]
}

/** 重置统计与授权状态（每个用例开始前调用） */
export function resetMockState(): void {
  deniedScopes = []
  pendingScopes = []
  grantedScopes = []
  authorizationRequests = []
  tokenRequests = 0
}

/** 读取授权统计（断言用） */
export function getMockStats(): {
  authorizationRequests: string[]
  tokenRequests: number
  grantedScopes: string[]
} {
  return {
    authorizationRequests: [...authorizationRequests],
    tokenRequests,
    grantedScopes: [...grantedScopes]
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function okEnvelope(res: ServerResponse, data: unknown): void {
  json(res, 200, { code: 0, data, message: 'ok' })
}

function splitScopes(scope: string): string[] {
  return scope.split(' ').filter((item) => item.length > 0)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
  })
}

function buildToken(scope: string, seq: number): Record<string, unknown> {
  return {
    access_token: `mock-access-token-${seq}`,
    token_type: 'Bearer',
    expires_in: 7200,
    refresh_token: `mock-refresh-token-${seq}`,
    scope: scope || 'skill:read',
    user: MOCK_USER
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${currentPort}`)

  if (req.method === 'POST' && url.pathname === '/api/oauth2/authorization-url') {
    const body = await readBody(req)
    const scope = typeof body.scope === 'string' ? body.scope : 'skill:read'
    const requested = splitScopes(scope)
    authorizationRequests.push(scope)
    pendingScopes = requested
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: typeof body.client_id === 'string' ? body.client_id : 'ke-work-desktop',
      redirect_uri: typeof body.redirect_uri === 'string' ? body.redirect_uri : '',
      scope,
      state: MOCK_STATE,
      code_challenge: typeof body.code_challenge === 'string' ? body.code_challenge : '',
      code_challenge_method:
        typeof body.code_challenge_method === 'string' ? body.code_challenge_method : 'S256'
    })
    return okEnvelope(res, {
      authorizeUrl: `http://127.0.0.1:${currentPort}/oauth2/authorize?${params.toString()}`,
      state: MOCK_STATE
    })
  }

  if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state') ?? ''
    if (!redirectUri) return json(res, 400, { error: 'invalid_request' })
    // 自动“同意”：直接回跳授权码
    res.writeHead(302, {
      Location: `${redirectUri}?code=mock-code-1&state=${encodeURIComponent(state)}`
    })
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/token') {
    tokenRequests += 1
    // 与真实后端一致：token 的 scope 为「已授予 ∪ 本次确认」
    const approved = pendingScopes.filter((scope) => !deniedScopes.includes(scope))
    grantedScopes = [...new Set([...grantedScopes, ...approved])]
    return json(res, 200, buildToken(grantedScopes.join(' '), tokenRequests))
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/refresh') {
    const scope = grantedScopes.length > 0 ? grantedScopes.join(' ') : pendingScopes.join(' ')
    return json(res, 200, buildToken(scope, tokenRequests + 1))
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/revoke') {
    return json(res, 200, {})
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/consents/revoke') {
    return okEnvelope(res, null)
  }

  // ── 同步接口（最小可用数据，保证“授权后可静默同步”）──
  if (req.method === 'GET' && url.pathname === '/api/expert-sync/list') {
    return okEnvelope(res, { items: [], total: 0, synced_at: Date.now() })
  }

  if (req.method === 'GET' && url.pathname === '/api/skill/list') {
    return okEnvelope(res, { items: [], total: 0, page: 1, page_size: 100 })
  }

  if (req.method === 'GET' && url.pathname === '/api/model-sync/list') {
    return okEnvelope(res, { version: 1, providers: [], models: [], synced_at: Date.now() })
  }

  return json(res, 404, { error: 'not_found' })
}

export function startMockOAuthServer(port = 8001): Promise<number> {
  return new Promise((resolve, reject) => {
    currentPort = port
    server = createServer((req, res) => {
      void handle(req, res)
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(port))
  })
}

export function stopMockOAuthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    const s = server
    server = null
    // 强制关闭浏览器可能残留的 keep-alive 连接，避免 close 回调等待
    s.closeAllConnections?.()
    s.close(() => resolve())
  })
}
