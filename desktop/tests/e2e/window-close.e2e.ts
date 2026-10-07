/**
 * 主窗口关闭行为回归：点窗口关闭按钮时按 ui.closeAction 三态执行。
 *
 * 覆盖：
 * A. 已保存「最小化到托盘」→ close 被拦截且窗口隐藏（不在任务栏占位、进程存活）、不弹确认框；
 * B. 已保存「直接关闭窗口」→ 应用正常退出（waitForEvent close，验证退出路径不被自身拦截）；
 * C. 首次（无配置）→ 弹应用内确认框 → 选「最小化到托盘」→ 落盘 settings.json → 再关不再询问；
 * D. 首次 → 弹框后 Esc 取消 → 窗口保持、不落盘；
 * E. 系统设置页改「关闭行为」→ 即时生效（设置浮层开着点关闭也按新选择执行）；
 * F. 用户菜单「退出应用」→ 默认「每次询问」下也直接退出（quit 不被关闭拦截拦下）。
 *
 * 托盘图标本身是原生 UI（Playwright 点不到），其菜单/唤回接线由单测
 * tests/unit/services/app-tray.test.ts 钉住；这里断言的是「窗口隐藏 + 进程存活」这一可观测结果。
 *
 * 触发方式：主进程侧 BrowserWindow.close()（与用户点标题栏 ✕ 同语义）。
 * 前置：npm run build；运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/window-close.e2e.ts
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>
type AppPage = Awaited<ReturnType<ElectronApp['firstWindow']>>

interface WindowState {
  visible: boolean
  minimized: boolean
  destroyed: boolean
}

/** 预置数据目录 + 可选 settings.json（磁盘嵌套格式，version:1）并启动应用 */
async function launchApp(closeAction?: 'ask' | 'tray' | 'close'): Promise<{
  app: ElectronApp
  page: AppPage
  dataHome: string
}> {
  const dataHome = mkdtempSync(join(tmpdir(), 'kw-close-'))
  execFileSync(process.execPath, [
    join(process.cwd(), 'tests', 'e2e', 'setup-test-data.mjs'),
    dataHome
  ])
  if (closeAction) {
    writeFileSync(
      join(dataHome, 'settings.json'),
      JSON.stringify({ version: 1, ui: { closeAction } }),
      'utf-8'
    )
  }
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
  return { app, page, dataHome }
}

/** 登录（主页面上的关闭行为是需求场景；确认框为 App.vue 全局挂载） */
async function login(page: AppPage): Promise<void> {
  await page.getByRole('button', { name: '密码登录' }).click()
  await page.getByPlaceholder('手机号 / 用户名').fill('e2euser')
  await page.getByPlaceholder('请输入密码（至少6位）').fill('Secret123!')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })
}

/** 与应用退出拦截共存的安全收尾（app.close 走 quit 路径，可能被「托盘」选择拦下） */
async function teardown(app: ElectronApp | undefined, dataHome: string): Promise<void> {
  if (app) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]).catch(
      () => {}
    )
    try {
      app.process().kill()
    } catch {
      // 进程已退出
    }
  }
  rmSync(dataHome, { recursive: true, force: true })
}

/** 主进程侧模拟点窗口关闭按钮（与用户手动点 ✕ 同语义） */
async function triggerClose(app: ElectronApp): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .forEach((win) => win.close())
  })
}

/** 唤回主窗口（等价于用户单击托盘图标；托盘本身是原生 UI，e2e 点不到） */
async function showMainWindow(app: ElectronApp): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

async function mainWindowState(app: ElectronApp): Promise<WindowState | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win
      ? { visible: win.isVisible(), minimized: win.isMinimized(), destroyed: win.isDestroyed() }
      : null
  })
}

/** 读取磁盘落盘的关闭行为（文件不存在/无该键返回 undefined） */
function readCloseAction(dataHome: string): string | undefined {
  const file = join(dataHome, 'settings.json')
  if (!existsSync(file)) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as { ui?: { closeAction?: string } }
  return raw.ui?.closeAction
}

const dialogOption = (page: AppPage): ReturnType<AppPage['locator']> =>
  page.locator('.close-confirm-btn--tray')

describe('主窗口关闭行为（最小化到托盘 / 直接关闭）', () => {
  it('已保存「最小化到托盘」：关闭被拦截并隐藏窗口（进程存活、不弹确认框）', async () => {
    const { app, page, dataHome } = await launchApp('tray')
    try {
      await login(page)
      await triggerClose(app)
      await expect
        .poll(async () => (await mainWindowState(app))?.visible, { timeout: 10_000 })
        .toBe(false)
      const state = await mainWindowState(app)
      expect(state?.destroyed).toBe(false)
      expect(state?.minimized).toBe(false) // 隐藏到托盘，不是最小化到任务栏
      expect(await dialogOption(page).count()).toBe(0)
    } finally {
      await teardown(app, dataHome)
    }
  })

  it('已保存「直接关闭窗口」：应用正常退出（退出路径不被拦截）', async () => {
    const { app, page, dataHome } = await launchApp('close')
    try {
      await login(page)
      await triggerClose(app)
      await app.waitForEvent('close', { timeout: 20_000 })
    } finally {
      await teardown(app, dataHome)
    }
  })

  it('首次关闭：弹确认框 → 选「最小化到托盘」→ 落盘且再关不再询问', async () => {
    const { app, page, dataHome } = await launchApp()
    try {
      await login(page)
      expect(readCloseAction(dataHome)).toBeUndefined()

      await triggerClose(app)
      await dialogOption(page).waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByRole('button', { name: '直接关闭窗口' }).waitFor({ state: 'visible' })
      await page.getByRole('button', { name: '取消' }).waitFor({ state: 'visible' })

      await dialogOption(page).click()
      // 离场后元素必须真正从 DOM 移除（窗口随后隐藏 → 渲染被暂停，
      // 若离场依赖 transitionend 会滞留，ModalShell 已改显式 :duration 兜底）
      await dialogOption(page).waitFor({ state: 'detached', timeout: 10_000 })
      await expect.poll(() => readCloseAction(dataHome), { timeout: 10_000 }).toBe('tray')
      await expect
        .poll(async () => (await mainWindowState(app))?.visible, { timeout: 10_000 })
        .toBe(false)
      expect((await mainWindowState(app))?.destroyed).toBe(false)

      // 唤回后再关：已记住选择，不再弹确认框，直接隐藏
      await showMainWindow(app)
      await expect
        .poll(async () => (await mainWindowState(app))?.visible, { timeout: 10_000 })
        .toBe(true)
      await triggerClose(app)
      await expect
        .poll(async () => (await mainWindowState(app))?.visible, { timeout: 10_000 })
        .toBe(false)
      expect(await dialogOption(page).count()).toBe(0)
    } finally {
      await teardown(app, dataHome)
    }
  })

  it('首次关闭 → Esc 取消：窗口保持、不落盘', async () => {
    const { app, page, dataHome } = await launchApp()
    try {
      await login(page)
      await triggerClose(app)
      await dialogOption(page).waitFor({ state: 'visible', timeout: 10_000 })

      await page.keyboard.press('Escape')
      await dialogOption(page).waitFor({ state: 'detached', timeout: 10_000 })

      const state = await mainWindowState(app)
      expect(state?.destroyed).toBe(false)
      expect(state?.visible).toBe(true)
      expect(state?.minimized).toBe(false)
      expect(['ask', undefined]).toContain(readCloseAction(dataHome))
    } finally {
      await teardown(app, dataHome)
    }
  })

  it('系统设置 →「关闭行为」改「最小化到托盘」：即时生效、关闭不询问', async () => {
    const { app, page, dataHome } = await launchApp()
    try {
      await login(page)
      // 头像菜单 → 设置 → 系统设置页 → 关闭行为下拉
      await page.locator('.user-avatar-btn').click()
      await page.locator('.menu-item', { hasText: '设置' }).first().click()
      await page.locator('.settings-card').waitFor({ state: 'visible', timeout: WAIT })
      await page.locator('.settings-nav-item', { hasText: '系统设置' }).first().click()

      const closeActionSelect = page.locator('.s-card', { hasText: '关闭行为' }).locator('select')
      await closeActionSelect.waitFor({ state: 'visible', timeout: WAIT })
      await closeActionSelect.selectOption('tray')
      await expect.poll(() => readCloseAction(dataHome), { timeout: 10_000 }).toBe('tray')

      // 设置浮层开着点关闭按钮：按新选择直接隐藏到托盘（不弹确认框）
      await triggerClose(app)
      await expect
        .poll(async () => (await mainWindowState(app))?.visible, { timeout: 10_000 })
        .toBe(false)
      expect((await mainWindowState(app))?.destroyed).toBe(false)
      expect(await dialogOption(page).count()).toBe(0)
    } finally {
      await teardown(app, dataHome)
    }
  })

  it('用户菜单「退出应用」：默认「每次询问」下也直接退出（不弹确认框、不被拦截）', async () => {
    const { app, page, dataHome } = await launchApp()
    try {
      await login(page)
      await page.locator('.user-avatar-btn').click()
      await page.locator('.menu-item', { hasText: '退出应用' }).click()
      await app.waitForEvent('close', { timeout: 20_000 })
    } finally {
      await teardown(app, dataHome)
    }
  })
})
