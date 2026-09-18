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

/** 读取响应体（用于断言回跳页文案） */
function requestBody(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
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

  it('回跳页标题与文案使用传入的系统名称（并做 HTML 转义）', async () => {
    const server = new DesktopOAuthCallbackServer(() => 'My<Work>')
    servers.push(server)
    await server.start()
    const redirectUri = server.getRedirectUri()
    server.setExpectedState('state-4')
    const pending = server.waitForCallback()
    const res = await requestBody(`${redirectUri}?code=code-4&state=state-4`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('<title>My&lt;Work&gt; 授权</title>')
    expect(res.body).toContain('请返回 My&lt;Work&gt; 桌面版继续操作。')
    await expect(pending).resolves.toEqual({ code: 'code-4' })
  })

  it('缺省系统名称为内置默认名', async () => {
    const server = new DesktopOAuthCallbackServer()
    servers.push(server)
    await server.start()
    const redirectUri = server.getRedirectUri()
    server.setExpectedState('state-5')
    const pending = server.waitForCallback()
    const res = await requestBody(`${redirectUri}?code=code-5&state=state-5`)
    expect(res.body).toContain('<title>Ke-Work 授权</title>')
    await expect(pending).resolves.toEqual({ code: 'code-5' })
  })

  it('非 /callback 路径返回 404', async () => {
    const { server, base } = await startServer()
    server.setExpectedState('state-3')
    const res = await request(`${base}/other`)
    expect(res.status).toBe(404)
  })
})
