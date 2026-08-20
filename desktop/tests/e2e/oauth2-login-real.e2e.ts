/**
 * E2E：真实 Web 后端 + 真实账号的 OAuth2 云端登录。
 *
 * 前置条件：
 * - Web 后端运行在 http://127.0.0.1:8001（uv run python run.py）
 * - Web 前端授权页运行在 http://localhost:5173（npm run dev -- --port 5173 --strictPort）
 * - 环境变量 OAUTH_TEST_ACCOUNT / OAUTH_TEST_PASSWORD 提供真实账号
 *
 * 流程：选中“云端工作”→ OAuth 面板 → 同意并登录 → 内嵌授权窗口（真实 Web 登录）→
 * 授权页确认 → 回跳 loopback → 账号关联 → 进入主页。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

const account = process.env.OAUTH_TEST_ACCOUNT
const password = process.env.OAUTH_TEST_PASSWORD

describe('E2E OAuth2 真实后端登录', () => {
  let dataHome: string
  let app: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<typeof electron.launch>> extends {
    firstWindow(): Promise<infer T>
  }
    ? T
    : never

  beforeAll(async () => {
    expect(account, '需设置 OAUTH_TEST_ACCOUNT').toBeTruthy()
    expect(password, '需设置 OAUTH_TEST_PASSWORD').toBeTruthy()
    dataHome = mkdtempSync(join(tmpdir(), 'kw-oauth-real-e2e-'))
  })

  afterAll(async () => {
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
    if (dataHome) {
      rmSync(dataHome, { recursive: true, force: true })
    }
  })

  it('E2E-OAUTH-REAL-01: 真实后端登录全流程', async () => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    delete env.ELECTRON_RUN_AS_NODE
    Object.assign(env, {
      KE_WORK_HOME: dataHome,
      KE_WORK_USER_DATA: join(dataHome, 'user-data'),
      WORKMATE_WEB_API_BASE_URL: 'http://127.0.0.1:8001',
      WORKMATE_OAUTH_INTERNAL_BROWSER: '1'
    })

    app = await electron.launch({ args: [APP_ENTRY], env })
    page = await app.firstWindow()
    await page.locator('.login-card').waitFor({ state: 'visible', timeout: WAIT })

    // 1. 选中云端工作 → OAuth 面板
    await page.getByText('云端工作').click()
    await page.locator('.oauth-panel').waitFor({ state: 'visible', timeout: 15_000 })

    // 2. 同意并登录 → 内嵌授权窗口出现
    const oauthWinPromise = app.waitForEvent('window')
    await page.getByRole('button', { name: '同意并登录' }).click()
    const oauthWin = await oauthWinPromise
    await oauthWin.waitForLoadState('domcontentloaded')
    // 诊断：输出授权窗口实际内容与截图
    console.log('OAUTH WIN URL:', oauthWin.url())
    const bodyText = await oauthWin.evaluate(
      () => document.body?.innerText?.slice(0, 500) ?? '(empty)'
    )
    console.log('OAUTH BODY:', bodyText)
    await oauthWin.screenshot({ path: join(dataHome, 'oauth-win.png') })

    // 3. 授权窗口：未登录则显示真实 Web 登录表单（默认账号密码 tab）
    await oauthWin.getByPlaceholder('请输入账号').waitFor({ state: 'visible', timeout: 20_000 })
    await oauthWin.getByPlaceholder('请输入账号').fill(account!)
    await oauthWin.getByPlaceholder('请输入密码').fill(password!)
    await oauthWin.getByRole('button', { name: '登录', exact: true }).click()
    // 诊断：登录后授权窗口的实际状态
    await oauthWin.waitForTimeout(5_000)
    console.log('AFTER LOGIN URL:', oauthWin.url())
    const afterText = await oauthWin.evaluate(
      () => document.body?.innerText?.slice(0, 800) ?? '(empty)'
    )
    console.log('AFTER LOGIN BODY:', afterText)
    await oauthWin.screenshot({ path: join(dataHome, 'oauth-after-login.png') })

    // 4. 登录成功 → 授权页出现 → 点击“授权”
    await oauthWin.getByRole('button', { name: '授权', exact: true }).waitFor({
      state: 'visible',
      timeout: 20_000
    })
    await oauthWin.getByRole('button', { name: '授权', exact: true }).click()

    // 5. 授权窗口自动关闭，主窗口进入主页
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })

    // 6. 验证主进程会话（userId + webAccountId）
    const sessionRaw = JSON.parse(
      readFileSync(join(dataHome, 'session.json'), 'utf-8')
    ) as { userId?: string; webAccountId?: string }
    expect(sessionRaw.userId).toBeTruthy()
    expect(sessionRaw.webAccountId).toBeTruthy()

    // 7. 本地库写入 oauth2_sessions 绑定记录
    const db = new DatabaseSync(join(dataHome, 'ke-work.db'))
    const row = db
      .prepare('SELECT web_account_id, scope FROM oauth2_sessions LIMIT 1')
      .get() as { web_account_id: string; scope: string } | undefined
    db.close()
    expect(row?.web_account_id).toBe(sessionRaw.webAccountId)
    expect(row?.scope).toContain('skill:read')
  }, 180_000)
})
