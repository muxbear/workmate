/**
 * Mock OAuth2 授权服务（E2E 用）。
 *
 * 模拟 Web 后端 OAuth2 端点 + 授权页：
 * - POST /api/oauth2/authorization-url → 返回带标准参数的授权页 URL（state 固定）
 * - GET  /oauth2/authorize → 自动“同意”，302 回跳 redirect_uri?code=...&state=...
 * - POST /api/oauth2/token / refresh / revoke → 标准响应
 *
 * 这样桌面端打开系统浏览器后授权页自动回跳，无需人工操作即可跑通
 * “同意 → 浏览器授权 → 回跳 → 换 token → 登录成功”全链路。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { URLSearchParams } from 'url'

const MOCK_STATE = 'mock-state-123'
const MOCK_USER = { id: 'mock-web-user-1', nickname: '测试用户', avatar: '' }

let server: ReturnType<typeof createServer> | null = null
let currentPort = 8001

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, string>)
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
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: body.client_id ?? 'ke-work-desktop',
      redirect_uri: body.redirect_uri ?? '',
      scope: body.scope ?? 'skill:read',
      state: MOCK_STATE,
      code_challenge: body.code_challenge ?? '',
      code_challenge_method: body.code_challenge_method ?? 'S256'
    })
    return json(res, 200, {
      code: 0,
      data: {
        authorizeUrl: `http://127.0.0.1:${currentPort}/oauth2/authorize?${params.toString()}`,
        state: MOCK_STATE
      },
      message: 'ok'
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
    const body = await readBody(req)
    return json(res, 200, buildToken(body.scope, 1))
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/refresh') {
    const body = await readBody(req)
    return json(res, 200, buildToken(body.scope, 2))
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth2/revoke') {
    return json(res, 200, {})
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
