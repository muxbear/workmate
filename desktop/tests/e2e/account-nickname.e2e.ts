/**
 * 账号昵称端到端：设置 → 账户管理 编辑昵称 → 全应用显示名生效并持久化。
 *
 * 覆盖：昵称写入（auth:update-nickname）→ 侧栏显示名即时切换（昵称 > 用户名）；
 * 重启同数据目录后仍显示昵称（session:check 权威回填）；清空昵称回退用户名。
 * 独立数据目录与独立文件：不改动 login.e2e 的 .user-name === 'e2euser' 断言。
 *
 * 前置：npm run build；运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/account-nickname.e2e.ts
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>
type AppPage = Awaited<ReturnType<ElectronApp['firstWindow']>>

/** 启动应用并等待登录页/主界面就绪（同一 dataHome 可多次调用，不再预置数据） */
async function launchApp(dataHome: string): Promise<{ app: ElectronApp; page: AppPage }> {
  const app = await electron.launch({
    args: [APP_ENTRY],
    env: {
      ...process.env,
      KE_WORK_HOME: dataHome,
      KE_WORK_USER_DATA: join(dataHome, 'user-data')
    }
  })
  const page = await app.firstWindow()
  await page
    .locator('.login-card, .home-layout')
    .first()
    .waitFor({ state: 'visible', timeout: WAIT })
  return { app, page }
}

/** 登录（预置账号 e2euser / Secret123!，见 setup-test-data.mjs） */
async function login(page: AppPage): Promise<void> {
  await page.getByRole('button', { name: '密码登录' }).click()
  await page.getByPlaceholder('手机号 / 用户名').fill('e2euser')
  await page.getByPlaceholder('请输入密码（至少6位）').fill('Secret123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })
}

/** 与应用退出拦截共存的安全收尾（同 window-close.e2e.ts：app.close 可能被托盘选择拦下） */
async function closeApp(app: ElectronApp): Promise<void> {
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(
    () => {}
  )
  try {
    app.process().kill()
  } catch {
    // 进程已退出
  }
}

/** 头像菜单 → 设置 → 账户管理（返回后昵称编辑按钮就绪） */
async function openAccountPage(page: AppPage): Promise<void> {
  await page.locator('.user-avatar-btn').click()
  await page.locator('.menu-item', { hasText: '设置' }).first().click()
  await page.locator('.settings-card').waitFor({ state: 'visible', timeout: WAIT })
  await page.locator('.settings-nav-item', { hasText: '账户管理' }).first().click()
  await page.locator('.nickname-edit-btn').waitFor({ state: 'visible', timeout: WAIT })
}

/** 在昵称弹窗里输入并保存（空串 = 清除昵称） */
async function submitNickname(page: AppPage, nickname: string): Promise<void> {
  await page.locator('.nickname-edit-btn').click()
  await page.locator('.ne-input').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.ne-input').fill(nickname)
  await page.locator('.ne-btn--primary').click()
  await page.locator('.ne-input').waitFor({ state: 'hidden', timeout: 10_000 })
}

describe('账号昵称（设置 → 账户管理 编辑并全应用生效）', () => {
  it('编辑昵称 → 侧栏即时切换；重启后保持；清空回退用户名', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'kw-nickname-'))
    execFileSync(process.execPath, [
      join(process.cwd(), 'tests', 'e2e', 'setup-test-data.mjs'),
      dataHome
    ])
    let app: ElectronApp | undefined
    try {
      // 1) 首次启动：登录后侧栏显示用户名
      let launched = await launchApp(dataHome)
      app = launched.app
      let page = launched.page
      await login(page)
      await expect
        .poll(() => page.locator('.user-name').textContent(), { timeout: 15_000 })
        .toBe('e2euser')

      // 2) 设置 → 账户管理 → 编辑昵称「老王」→ 侧栏即时切换
      await openAccountPage(page)
      await submitNickname(page, '老王')
      await expect.poll(() => page.locator('.user-name').textContent(), { timeout: 10_000 }).toBe('老王')

      // 3) 重启同一数据目录：昵称持久化（session:check 权威回填，无需重新登录）
      await closeApp(app)
      launched = await launchApp(dataHome)
      app = launched.app
      page = launched.page
      await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })
      await expect.poll(() => page.locator('.user-name').textContent(), { timeout: 15_000 }).toBe('老王')

      // 4) 清空昵称 → 显示名回退用户名
      await openAccountPage(page)
      await submitNickname(page, '')
      await expect
        .poll(() => page.locator('.user-name').textContent(), { timeout: 10_000 })
        .toBe('e2euser')
    } finally {
      if (app) await closeApp(app)
      rmSync(dataHome, { recursive: true, force: true })
    }
  }, 120_000)
})
