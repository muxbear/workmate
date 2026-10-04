/**
 * E2E：云知识库在桌面端的展示方式（与本地库共用同一套工作台）
 *
 * 前置：npm run build（生成 out/）
 * 运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/knowledge-cloud-view.e2e.ts
 *
 * 云数据用主进程 IPC 桩注入（不依赖后端与 Web 账号）：本用例关注的是**渲染契约**——
 * 云库必须和本地库一样落在左栏工作台里（左栏分组栏常在、同一套文件表格与预览），
 * 而不是另起一套页面。解析、降级与缓存规则由单测覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

const CLOUD_KB = {
  id: 'kb-cloud-1',
  name: 'LangChain 技术文档',
  description: '云端同步的资料',
  docsCount: 2,
  chunksCount: 10,
  sizeDisplay: '1.2 MB',
  visibility: 'public',
  isOwner: true,
  ownerName: null,
  access: 'owner',
  updatedAt: '2026-09-27T01:02:03'
}

const CLOUD_DOCS = [
  {
    id: 'doc-1',
    name: 'intro.md',
    type: 'md',
    sizeDisplay: '2 KB',
    status: 'indexed',
    chunksCount: 3,
    folder: null,
    uploadedAt: '2026-09-27T01:00:00',
    indexedAt: '2026-09-27T01:01:00',
    errorMessage: null
  },
  {
    id: 'doc-2',
    name: 'guide.md',
    type: 'md',
    sizeDisplay: '3 KB',
    status: 'queued',
    chunksCount: 0,
    folder: '手册',
    uploadedAt: '2026-09-26T01:00:00',
    indexedAt: null,
    errorMessage: null
  }
]

describe('E2E 云知识库展示', () => {
  let dataHome: string
  let app: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<typeof electron.launch>> extends {
    firstWindow(): Promise<infer T>
  }
    ? T
    : never

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), 'kw-e2e-kbcloud-'))
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

    await page.getByRole('button', { name: '密码登录' }).click()
    await page.getByPlaceholder('手机号 / 用户名').fill('e2euser')
    await page.getByPlaceholder('请输入密码（至少6位）').fill('Secret123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })

    // 注入云知识库桩（主进程侧），再进入知识库页让渲染层据此同步
    await app.evaluate(
      ({ ipcMain }, data) => {
        const ok = <T>(payload: T): { success: true; data: T } => ({ success: true, data: payload })
        const channels: Array<[string, () => unknown]> = [
          ['knowledge-cloud:status', () => ok({ linked: true, hasScope: true })],
          [
            'knowledge-cloud:list',
            () => ok({ state: 'ok', message: '', items: data.kbs, total: data.kbs.length, page: 1, pageSize: 100 })
          ],
          ['knowledge-cloud:invitations', () => ok({ state: 'ok', message: '', items: [] })],
          [
            'knowledge-cloud:list-docs',
            () => ok({ state: 'ok', message: '', items: data.docs, total: data.docs.length, page: 1, pageSize: 100 })
          ],
          ['knowledge-cloud:get-kb', () => ok({ state: 'ok', message: '', kb: data.kbs[0] })],
          [
            'knowledge-cloud:read-file',
            () => ok({ content: '# 云文档正文\n这是云端文档', ext: 'md', name: 'intro.md' })
          ]
        ]
        for (const [channel, handler] of channels) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, async () => handler())
        }
      },
      { kbs: [CLOUD_KB], docs: CLOUD_DOCS }
    )

    await page.getByText('知识库', { exact: true }).first().click()
    await page.locator('.kb-group').first().waitFor({ state: 'visible', timeout: WAIT })
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    rmSync(dataHome, { recursive: true, force: true })
  })

  it('KC-01: 云分组列出同步来的知识库', async () => {
    // 按分组名定位（不按序号）：自有的库语义上属于「云个人知识库」，桩对 personal/public 返回同一份列表
    const cloudGroup = page.locator('.kb-group', { hasText: '云个人知识库' })
    await cloudGroup.getByText('LangChain 技术文档').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await cloudGroup.locator('.kb-lib-name').allTextContents()).toEqual(['LangChain 技术文档'])
  }, 90_000)

  it('KC-02: 点云库后仍在同一工作台里展示（左栏分组栏保持可见）', async () => {
    await page.locator('.kb-group', { hasText: '云个人知识库' }).getByText('LangChain 技术文档').click()

    // 关键回归：云库不再替换整页——分组栏与工作台都还在
    await page.locator('.kb-workbench').waitFor({ state: 'visible', timeout: 10_000 })
    expect(await page.locator('.kb-groups').isVisible()).toBe(true)
    expect((await page.locator('.kb-files-title').textContent())?.trim()).toBe('LangChain 技术文档')
  }, 90_000)

  it('KC-03: 文件区与本地同一套表格（含目录层级与状态标签）', async () => {
    const table = page.locator('.kb-table')
    await table.locator('.kb-table-row').first().waitFor({ state: 'visible', timeout: 10_000 })

    // 表头与本地一致
    const heads = (await table.locator('.kb-sort-btn').allTextContents()).map((text) => text.trim())
    expect(heads).toEqual(expect.arrayContaining(['名称', '大小', '更新时间']))

    // 根级：文件夹 + 文件（guide.md 在「手册」目录下，文件夹默认折叠——与本地一致）
    const names = (await table.locator('.kb-file-name').allTextContents()).map((t) => t.trim())
    expect(names).toEqual(expect.arrayContaining(['手册', 'intro.md']))
    const tags = (await table.locator('.kb-file-tag').allTextContents()).map((t) => t.trim())
    expect(tags).toEqual(expect.arrayContaining(['1 项']))
    expect(names).not.toContain('guide.md')

    // 展开文件夹：云端层级与本地同款，且未索引文档带本地同款标签
    await table.getByText('手册').click()
    await table.getByText('guide.md').waitFor({ state: 'visible', timeout: 10_000 })
    const expandedTags = (await table.locator('.kb-file-tag').allTextContents()).map((t) => t.trim())
    expect(expandedTags).toEqual(expect.arrayContaining(['未索引']))
  }, 90_000)

  it('KC-04: 云库没有「问答」标签（只读浏览）', async () => {
    const tabNames = await page.locator('.kb-tab-name').allTextContents()
    expect(tabNames).not.toContain('问答')
  }, 90_000)

  it('KC-05: 点云文档在本页右侧预览（本地同款预览面板）', async () => {
    await page.locator('.kb-table').getByText('intro.md').click()

    // 生成标签页并渲染正文
    await page.locator('.kb-tab-name', { hasText: 'intro.md' }).waitFor({
      state: 'visible',
      timeout: 10_000
    })
    await page.getByText('这是云端文档').first().waitFor({ state: 'visible', timeout: 10_000 })
  }, 90_000)

  it('KC-06: 云库的操作菜单只读（库级：刷新；文档级：预览/下载）', async () => {
    // 库级菜单
    await page.locator('.kb-library-more').click()
    const libItems = await page.locator('.kb-library-menu .kb-lib-menu-item').allTextContents()
    expect(libItems.map((text) => text.trim())).toEqual(['刷新'])
    await page.keyboard.press('Escape')

    // 文档级菜单（悬浮行上的三点）
    const row = page.locator('.kb-table-row', { hasText: 'intro.md' })
    await row.locator('.kb-row-more-btn').click()
    const rowItems = await row.locator('.kb-row-menu .kb-lib-menu-item').allTextContents()
    expect(rowItems.map((text) => text.trim())).toEqual(['预览', '下载'])
  }, 90_000)

  it('KC-07: 截图存档（人工核对云库与本地是否同一套展示）', async () => {
    await page.keyboard.press('Escape')
    await page.mouse.move(600, 400)
    await page.waitForTimeout(200)
    const shot = join(tmpdir(), 'kw-knowledge-cloud-view.png')
    await page.screenshot({ path: shot, fullPage: false })
    console.log('[e2e] 云库截图:', shot)
    expect(true).toBe(true)
  }, 90_000)
})
