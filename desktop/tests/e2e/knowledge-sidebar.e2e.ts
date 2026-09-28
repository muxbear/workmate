/**
 * E2E：知识库侧栏（分组结构、点分组行=「查看更多」、折叠只归箭头）
 *
 * 前置：npm run build（生成 out/）
 * 运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/knowledge-sidebar.e2e.ts
 * 预置账号：e2euser / Secret123!（setup-test-data.mjs 写入隔离数据目录）
 *
 * 云端分组在 e2e 环境里没有绑定 Web 账号，因此走的是「未登录提示」分支——
 * 真实云端数据链路需要后端，不在此用例范围内（由单测覆盖解析与降级）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

/** 侧栏应有且仅有的五个分组（顺序即展示顺序） */
const EXPECTED_GROUPS = ['本地知识库', '云个人知识库', '云公共知识库', '我的共享知识', '共享给我的']

describe('E2E 知识库侧栏', () => {
  let dataHome: string
  let app: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<typeof electron.launch>> extends {
    firstWindow(): Promise<infer T>
  }
    ? T
    : never

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), 'kw-e2e-kb-'))
    execFileSync(process.execPath, [
      join(process.cwd(), 'tests', 'e2e', 'setup-test-data.mjs'),
      dataHome
    ])
    app = await electron.launch({
      args: [APP_ENTRY],
      env: {
        ...process.env,
        KE_WORK_HOME: dataHome,
        KE_WORK_USER_DATA: join(dataHome, 'user-data')
      }
    })
    page = await app.firstWindow()

    // 登录并进入知识库页
    await page.getByRole('button', { name: '密码登录' }).click()
    await page.getByPlaceholder('手机号 / 用户名').fill('e2euser')
    await page.getByPlaceholder('请输入密码（至少6位）').fill('Secret123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })
    await page.getByText('知识库', { exact: true }).first().click()
    await page.locator('.kb-group').first().waitFor({ state: 'visible', timeout: WAIT })
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    rmSync(dataHome, { recursive: true, force: true })
  })

  it('KS-01: 侧栏为五个分组，且不再有「云端知识库」', async () => {
    const labels = await page.locator('.kb-group-label').allTextContents()
    expect(labels).toEqual(EXPECTED_GROUPS)
    expect(labels).not.toContain('云端知识库')
  }, 90_000)

  it('KS-02: 点分组行直接进入「查看更多」，不弹下拉菜单', async () => {
    // 点「本地知识库」整行（不是箭头）
    await page.locator('.kb-group').first().locator('.kb-group-toggle').click()

    // 关键：点行不弹菜单（菜单只由右侧三点按钮触发）
    expect(await page.locator('.kb-group-menu').count()).toBe(0)

    // 与菜单里的「查看更多」同一个去向：该分组的全量列表页
    const more = page.locator('.kb-more')
    await more.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await more.locator('.kb-more-title').textContent()).toBe('本地知识库')

    // 返回工作台
    await page.locator('.kb-breadcrumb-link').click()
    await page.locator('.kb-workbench').waitFor({ state: 'visible', timeout: 10_000 })
  }, 90_000)

  it('KS-02b: 右侧三点按钮仍能打开菜单（本地分组：查看更多 + 新建）', async () => {
    await page.locator('.kb-group').first().locator('.kb-group-more').hover()
    const menu = page.locator('.kb-group-menu')
    await menu.waitFor({ state: 'visible', timeout: 10_000 })

    const items = await menu.locator('.kb-group-menu-item').allTextContents()
    expect(items.map((text) => text.trim())).toEqual(['查看更多', '新建知识库'])
  }, 90_000)

  it('KS-03: 折叠仍由右侧箭头负责', async () => {
    const localGroup = page.locator('.kb-group').first()
    // 缺省展开
    expect(await localGroup.locator('.kb-group-items').count()).toBe(1)

    await localGroup.locator('.kb-group-chevron').click()
    expect(await localGroup.locator('.kb-group-items').count()).toBe(0)

    await localGroup.locator('.kb-group-chevron').click()
    expect(await localGroup.locator('.kb-group-items').count()).toBe(1)
  }, 90_000)

  it('KS-04: 未绑定 Web 账号时云分组给出可读提示，且不给「去授权」按钮', async () => {
    const cloudGroup = page.locator('.kb-group').nth(1)
    const hint = cloudGroup.locator('.kb-group-hint')
    await hint.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await hint.textContent()).toContain('Web 账号')
    // 没绑账号时该做的是先登录，「去授权」在这里是误导
    expect(await hint.locator('.kb-group-hint-btn').count()).toBe(0)
  }, 90_000)

  it('KS-05: 截图存档（人工核对视觉）', async () => {
    // 先关掉可能残留的菜单（KS-02b 悬浮展开过），截图要的是干净侧栏
    await page.keyboard.press('Escape')
    await page.mouse.move(600, 400)
    await page.waitForTimeout(200)

    // 存到临时目录（dataHome 会在 afterAll 被清掉），便于人工核对
    const shot = join(tmpdir(), 'kw-knowledge-sidebar.png')
    await page.screenshot({ path: shot, fullPage: false })
    console.log('[e2e] 侧栏截图:', shot)
    expect(await page.locator('.kb-group-menu').count()).toBe(0)
  }, 90_000)
})
