/**
 * E2E：云端工作 OAuth2 登录全流程（Playwright 驱动 Electron + Mock OAuth2 服务）
 *
 * 流程：登录页选中“云端工作” → OAuth 面板 → 点击“同意并登录” →
 * mock 授权页自动同意回跳 → 换取 token → 新建 web-only 本地用户 → 进入主页。
 * 前置：npm run build（生成 out/）；无需真实 Web 后端。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { startMockOAuthServer, stopMockOAuthServer } from './mock-oauth-server'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

describe('E2E OAuth2 云端登录', () => {
  let dataHome: string
  let app: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<typeof electron.launch>> extends {
    firstWindow(): Promise<infer T>
  }
    ? T
    : never

  beforeAll(async () => {
    await startMockOAuthServer(8010)
    dataHome = mkdtempSync(join(tmpdir(), 'kw-oauth-e2e-'))
  })

  afterAll(async () => {
    // 部分环境下 Electron 退出较慢，给 close 加超时兜底
    await Promise.race([
      app?.close() ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
    if (app) {
      try {
        app.process().kill()
      } catch {
        // 进程已退出
      }
    }
    await stopMockOAuthServer()
    if (dataHome) {
      rmSync(dataHome, { recursive: true, force: true })
    }
  })

  it('E2E-OAUTH-01: 云端工作 → OAuth 面板 → 同意登录 → 进入主页并落库绑定', async () => {
    // 显式移除 ELECTRON_RUN_AS_NODE，确保被测应用以 Electron 模式启动
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    Object.assign(env, {
      KE_WORK_HOME: dataHome,
      KE_WORK_USER_DATA: join(dataHome, 'user-data'),
      WORKMATE_WEB_API_BASE_URL: 'http://127.0.0.1:8010'
    })

    app = await electron.launch({ args: [APP_ENTRY], env })
    page = await app.firstWindow()
    await page.locator('.login-card').waitFor({ state: 'visible', timeout: WAIT })

    // 1. 选中“云端工作”
    await page.getByText('云端工作').click()
    await page
      .locator('.mode-btn--active')
      .filter({ hasText: '云端工作' })
      .waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('.oauth-panel').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: '同意并登录' }).waitFor({ state: 'visible' })

    // 2. 同意并登录（mock 授权页自动同意并回跳）
    await page.getByRole('button', { name: '同意并登录' }).click()
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })

    // 3. 主进程会话写入 userId + webAccountId
    const sessionRaw = JSON.parse(
      readFileSync(join(dataHome, 'session.json'), 'utf-8')
    ) as { userId?: string; webAccountId?: string }
    expect(sessionRaw.userId).toBeTruthy()
    expect(sessionRaw.webAccountId).toBe('mock-web-user-1')

    // 4. 本地库写入 oauth2_sessions 绑定记录
    const db = new DatabaseSync(join(dataHome, 'ke-work.db'))
    const row = db
      .prepare('SELECT web_account_id, scope FROM oauth2_sessions LIMIT 1')
      .get() as { web_account_id: string; scope: string } | undefined
    db.close()
    expect(row?.web_account_id).toBe('mock-web-user-1')
    expect(row?.scope).toContain('skill:read')

    // 5. 路由守卫允许进入主页（主进程会话为权威）
    expect(await page.locator('.home-layout').count()).toBeGreaterThan(0)
  }, 120_000)
})
