import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'http'
import { DesktopOAuthCallbackServer } from '../../../src/main/oauth2/DesktopOAuthCallbackServer'

const servers: DesktopOAuthCallbackServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()))
})

function request(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0 })
    }).on('error', reject)
  })
}

async function startServer(): Promise<{
  server: DesktopOAuthCallbackServer
  redirectUri: string
  base: string
}> {
  const server = new DesktopOAuthCallbackServer()
  servers.push(server)
  await server.start()
  const redirectUri = server.getRedirectUri()
  const port = new URL(redirectUri).port
  return { server, redirectUri, base: `http://127.0.0.1:${port}` }
}

describe('DesktopOAuthCallbackServer', () => {
  it('匹配 state 的回调返回授权码并结束流程', async () => {
    const { server, redirectUri } = await startServer()
    server.setExpectedState('state-1')
    const pending = server.waitForCallback()
    const res = await request(`${redirectUri}?code=code-1&state=state-1`)
    expect(res.status).toBe(200)
    await expect(pending).resolves.toEqual({ code: 'code-1' })
  })

  it('state 不匹配只返回 400，不结束流程（防探测中断）', async () => {
    const { server, redirectUri } = await startServer()
    server.setExpectedState('state-1')
    const pending = server.waitForCallback()
    const res = await request(`${redirectUri}?code=evil&state=wrong`)
    expect(res.status).toBe(400)
    // 流程未结束：发送合法回调仍能成功
    const res2 = await request(`${redirectUri}?code=code-2&state=state-1`)
    expect(res2.status).toBe(200)
    await expect(pending).resolves.toEqual({ code: 'code-2' })
  })

  it('error=access_denied 返回错误结果', async () => {
    const { server, redirectUri } = await startServer()
    server.setExpectedState('state-2')
    const pending = server.waitForCallback()
    const res = await request(`${redirectUri}?error=access_denied&state=state-2`)
    expect(res.status).toBe(200)
    await expect(pending).resolves.toEqual({ error: 'access_denied' })
  })

  it('非 /callback 路径返回 404', async () => {
    const { server, base } = await startServer()
    server.setExpectedState('state-3')
    const res = await request(`${base}/other`)
    expect(res.status).toBe(404)
  })
})
