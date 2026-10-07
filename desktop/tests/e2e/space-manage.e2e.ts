/**
 * 空间管理页 e2e：入口 hover 按钮 → 管理页（左列空间 CRUD/拖拽排序 + 右列任务改名/删除）
 * 前置：npm run build；运行：npx vitest run --config vitest.e2e.config.ts tests/e2e/space-manage.e2e.ts
 *
 * 隔离注意：KE_WORK_HOME 不隔离工作空间目录（DEFAULT_WORKSPACE_DIR = ~/KeWork），
 * 故空间名用 ASCII，afterAll 里按名字删除 ~/KeWork/<name>（同 remove-workspace.e2e.ts）。
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, stopMockLlmServer } from './mock-llm-server'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000

describe('E2E 空间管理页', () => {
  let llmBaseUrl = ''
  let dataHome: string
  let app: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<typeof electron.launch>> extends {
    firstWindow(): Promise<infer T>
  }
    ? T
    : never
  /** 被测空间（前置步骤创建，绑定了 1 条任务） */
  let wsName = ''
  let wsDir = ''
  /** 排序用例创建的第二个空间 */
  let wsName2 = ''
  let wsDir2 = ''
  /** 分页用例的空间（11 条会话，够两页） */
  let pageWsName = ''
  let pageWsDir = ''

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), 'kw-spacemanage-'))
    execFileSync(process.execPath, [
      join(process.cwd(), 'tests', 'e2e', 'setup-test-data.mjs'),
      dataHome
    ])
    llmBaseUrl = await startMockLlmServer()
    app = await electron.launch({
      args: [APP_ENTRY],
      env: {
        ...process.env,
        KE_WORK_HOME: dataHome,
        KE_WORK_USER_DATA: join(dataHome, 'user-data'),
        DEEPSEEK_BASE_URL: `${llmBaseUrl}/chat/completions`
      }
    })
    page = await app.firstWindow()
    await page
      .locator('.login-card, .home-layout')
      .first()
      .waitFor({ state: 'visible', timeout: WAIT })
    await page.getByRole('button', { name: '密码登录' }).click()
    await page.getByPlaceholder('手机号 / 用户名').fill('e2euser')
    await page.getByPlaceholder('请输入密码（至少6位）').fill('Secret123!')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })
  })

  afterAll(async () => {
    await app?.close().catch(() => {})
    await stopMockLlmServer()
    rmSync(dataHome, { recursive: true, force: true })
    // 空间目录落在真实用户目录 ~/KeWork/<name>（删空间只删记录），须一并清理
    for (const dir of [wsDir, wsDir2, pageWsDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  /** 新建任务页发送一条消息（创建会话并绑定当前空间） */
  async function sendMessage(text: string): Promise<void> {
    await page.getByText('新建任务').first().click()
    await page.waitForTimeout(800)
    await page.locator('.task-textarea').first().fill(text)
    await page.locator('.send-btn').first().click()
    await page
      .locator('.send-btn--stop')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})
    await page
      .locator('.send-btn--stop')
      .first()
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .catch(() => {})
    await page.waitForTimeout(1_000)
  }

  /** 在输入卡的空间菜单里新建空间（切到新建任务页） */
  async function createSpaceFromInputCard(name: string): Promise<void> {
    await page.getByText('新建任务').first().click()
    await page.waitForTimeout(800)
    await page.locator('[data-workspace-menu-trigger]').click()
    await page.getByText('新建工作空间').click()
    await page.locator('#prompt-ws-create-name').fill(name)
    await page.getByRole('button', { name: '创建', exact: true }).click()
    await page
      .locator('[data-workspace-menu-trigger]')
      .filter({ hasText: name })
      .waitFor({ state: 'visible', timeout: 10_000 })
  }

  /** 悬停「空间」行 → 点「管理」进入管理页 */
  async function openManagePage(): Promise<void> {
    await page.mouse.move(2, 2)
    await page.locator('.spaces-row').first().hover()
    await page.locator('.spaces-manage').first().click()
    await page.locator('.space-manage').waitFor({ state: 'visible', timeout: 5_000 })
  }

  /** 左列按名字定位空间行 */
  function spaceRow(name: string): ReturnType<typeof page.locator> {
    return page.locator('.space-row').filter({ hasText: name }).first()
  }

  /**
   * 精简版发送（分页用例要连发 11 条，省掉固定等待，改为等侧栏会话数到位）。
   * expectTotal 为本次发送后侧栏应有的会话总数 —— 用正反馈替代固定 sleep，避免发送未落库就进下一条。
   */
  async function sendMessageFast(text: string, expectTotal: number): Promise<void> {
    await page.getByText('新建任务').first().click()
    await page.locator('.task-textarea').first().fill(text)
    await page.locator('.send-btn').first().click()
    await page
      .locator('.send-btn--stop')
      .first()
      .waitFor({ state: 'hidden', timeout: 20_000 })
      .catch(() => {})
    await expect
      .poll(() => page.locator('.space-chat').count(), { timeout: 20_000 })
      .toBe(expectTotal)
  }

  it('前置: 新建空间 + 发送 1 条消息（1 条任务绑定该空间）', async () => {
    // 名字须为 ASCII：Windows 下含非 ASCII 名的目录 rmSync 静默失败
    wsName = `sm-manage-${Date.now().toString(36)}`
    await createSpaceFromInputCard(wsName)
    wsDir = join(homedir(), 'KeWork', wsName)
    await sendMessage('空间管理测试')
    const group = page.locator('.space-group').filter({ hasText: wsName })
    await group.locator('.space-chat').first().waitFor({ state: 'visible', timeout: WAIT })
    expect(await group.locator('.space-chat').count()).toBe(1)
  }, 240_000)

  it('入口: 悬停「空间」行出现「管理」按钮 → 进入管理页 → 返回回到来源页', async () => {
    // 未悬停时按钮不可见（visibility: hidden）；悬停该行后显形
    await page.mouse.move(2, 2)
    await page.locator('.spaces-manage').first().waitFor({ state: 'hidden', timeout: 5_000 })
    await page.locator('.spaces-row').first().hover()
    await page.locator('.spaces-manage').first().waitFor({ state: 'visible', timeout: 5_000 })

    await page.locator('.spaces-manage').first().click()
    await page.locator('.space-manage').waitFor({ state: 'visible', timeout: 5_000 })
    expect(await page.locator('.sm-header-title').textContent()).toContain('空间管理')

    // 返回：回到进入前的页面（新建任务页）
    await page.locator('.sm-back').click()
    await page.locator('.space-manage').waitFor({ state: 'hidden', timeout: 5_000 })
    await page.locator('.task-textarea').first().waitFor({ state: 'visible', timeout: 5_000 })
  }, 90_000)

  it('左列: 默认空间只读置顶（无改名/删除按钮、不可拖拽）', async () => {
    await openManagePage()
    const defaultRow = page.locator('.space-row--default')
    await defaultRow.waitFor({ state: 'visible', timeout: 5_000 })
    expect(await defaultRow.count()).toBe(1)
    // 置顶：第一个空间行就是默认空间行
    const firstRowClass = await page.locator('.sm-list .space-row').first().getAttribute('class')
    expect(firstRowClass).toContain('space-row--default')
    // 只读：无操作按钮、标了只读、不可拖拽
    expect(await defaultRow.locator('.space-row-btn').count()).toBe(0)
    expect(await defaultRow.getAttribute('draggable')).toBeNull()
    expect(await defaultRow.locator('.space-row-tag').textContent()).toContain('只读')
  }, 90_000)

  it('右列: 选中空间展示其任务 → 任务改名同步侧栏', async () => {
    await spaceRow(wsName).click()
    const task = page.locator('.sm-task').first()
    await task.waitFor({ state: 'visible', timeout: 5_000 })
    expect(await page.locator('.sm-task').count()).toBe(1)

    await task.hover()
    await task.locator('.sm-task-btn').first().click()
    await page.locator('.sr-input').waitFor({ state: 'visible', timeout: 5_000 })
    const newTitle = `改名任务-${Date.now().toString(36)}`
    await page.locator('.sr-input').fill(newTitle)
    await page.locator('.sr-btn--primary').click()
    await page.locator('.sr-input').waitFor({ state: 'hidden', timeout: 5_000 })

    expect(await page.locator('.sm-task-title').first().textContent()).toContain(newTitle)
    // 侧栏会话行同步（列表来自同一 agentStore）
    const group = page.locator('.space-group').filter({ hasText: wsName })
    expect(await group.locator('.space-chat-title').first().textContent()).toContain(newTitle)
  }, 90_000)

  it('左列: 空间改名 → 侧栏分组抬头同步，磁盘目录名不变', async () => {
    const renamed = `${wsName}-r`
    await spaceRow(wsName).hover()
    await spaceRow(wsName).locator('.space-row-btn').first().click()
    await page.locator('.sr-input').waitFor({ state: 'visible', timeout: 5_000 })
    await page.locator('.sr-input').fill(renamed)
    await page.locator('.sr-btn--primary').click()
    await page.locator('.sr-input').waitFor({ state: 'hidden', timeout: 5_000 })

    expect(await spaceRow(renamed).count()).toBe(1)
    // 侧栏「空间」分组的抬头同步为新名
    await expect
      .poll(
        () => page.locator('.space-group').filter({ hasText: renamed }).count(),
        { timeout: 5_000 }
      )
      .toBe(1)
    // 改名只改展示名：磁盘目录仍是旧名（本方案明确不改目录）
    expect(wsDir).toBe(join(homedir(), 'KeWork', wsName))
    wsName = renamed
  }, 90_000)

  it('左列: 新建空间排在最前 + 拖拽排序持久化（切走再回来顺序不变）', async () => {
    wsName2 = `sm-manage2-${Date.now().toString(36)}`
    await page.locator('.sm-list-add').click()
    await page.locator('#prompt-ws-create-name').fill(wsName2)
    await page.getByRole('button', { name: '创建', exact: true }).click()
    wsDir2 = join(homedir(), 'KeWork', wsName2)

    // 新建即排在最前（可排序区第一位）
    await expect
      .poll(
        () =>
          page
            .locator('.sm-list .space-row:not(.space-row--default) .space-row-name')
            .first()
            .textContent(),
        { timeout: 5_000 }
      )
      .toContain(wsName2)

    // 把第二个空间（wsName，当前排第二）拖到第一条（wsName2）的上半区 → 应插到它之前
    // 必须用 dragTo：原生 HTML5 拖拽事件只在 Playwright 的拖拽拦截下才会产生
    const source = page.locator('.space-row').filter({ hasText: wsName }).first()
    const target = page.locator('.space-row').filter({ hasText: wsName2 }).first()
    const tBox = (await target.boundingBox())!
    await source.dragTo(target, {
      targetPosition: { x: tBox.width / 2, y: Math.max(4, tBox.height * 0.2) }
    })

    await expect
      .poll(
        () =>
          page
            .locator('.sm-list .space-row:not(.space-row--default) .space-row-name')
            .first()
            .textContent(),
        { timeout: 5_000 }
      )
      .toContain(wsName)

    // 切走再回来：顺序来自主进程（已落库）
    await page.locator('.sm-back').click()
    await page.locator('.space-manage').waitFor({ state: 'hidden', timeout: 5_000 })
    await openManagePage()
    expect(
      await page.locator('.sm-list .space-row:not(.space-row--default) .space-row-name').first()
        .textContent()
    ).toContain(wsName)
  }, 120_000)

  it('右列: 删除任务 → 确认后任务消失且侧栏会话同步移除', async () => {
    await spaceRow(wsName).click()
    const task = page.locator('.sm-task').first()
    await task.waitFor({ state: 'visible', timeout: 5_000 })
    await task.hover()
    await task.locator('.sm-task-btn--danger').click()
    await page.locator('.ms-mask').waitFor({ state: 'visible', timeout: 5_000 })
    expect(await page.locator('.confirm-message').textContent()).toContain('删除后对话记录无法恢复')
    await page.locator('.confirm-btn--danger').click()

    await expect.poll(() => page.locator('.sm-task').count(), { timeout: 5_000 }).toBe(0)
    const group = page.locator('.space-group').filter({ hasText: wsName })
    await expect.poll(() => group.locator('.space-chat').count(), { timeout: 5_000 }).toBe(0)
  }, 90_000)

  it('分页前置: 新建空间 + 连发 11 条消息（够两页）', async () => {
    pageWsName = `sm-page-${Date.now().toString(36)}`
    await createSpaceFromInputCard(pageWsName)
    pageWsDir = join(homedir(), 'KeWork', pageWsName)
    const base = await page.locator('.space-chat').count()
    for (let i = 1; i <= 11; i += 1) {
      await sendMessageFast(`分页用例 ${i}`, base + i)
    }
    const group = page.locator('.space-group').filter({ hasText: pageWsName })
    await expect
      .poll(() => group.locator('.space-chat').count(), { timeout: 60_000 })
      .toBe(11)
  }, 300_000)

  it('分页: 总条数 / 翻页 / 跳页（含越界夹取）/ 改每页条数', async () => {
    await openManagePage()
    await spaceRow(pageWsName).click()
    await page.locator('.sm-task').first().waitFor({ state: 'visible', timeout: 5_000 })

    // ① 展示条数：抬头与分页条都给出总数
    expect(await page.locator('.sm-detail-meta').textContent()).toContain('11 个任务')
    expect(await page.locator('.sm-pager-total').textContent()).toContain('共 11 条')

    // ② 首页：10 行，页码 1/2，上一页禁用
    expect(await page.locator('.sm-task').count()).toBe(10)
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 1 / 2 页')
    expect(await page.locator('.sm-pager-btn').first().isDisabled()).toBe(true)

    // ③ 翻页：下一页 → 第 2 页只剩 1 行，下一页禁用
    await page.getByRole('button', { name: '下一页' }).click()
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 2 / 2 页')
    expect(await page.locator('.sm-task').count()).toBe(1)
    expect(await page.getByRole('button', { name: '下一页' }).isDisabled()).toBe(true)

    // ④ 跳页：越界输入夹取到最后一页
    await page.locator('.sm-pager-input').fill('99')
    await page.getByRole('button', { name: '跳转' }).click()
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 2 / 2 页')
    // 跳回第 1 页
    await page.locator('.sm-pager-input').fill('1')
    await page.getByRole('button', { name: '跳转' }).click()
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 1 / 2 页')
    expect(await page.locator('.sm-task').count()).toBe(10)

    // ⑤ 改每页条数：20 条/页 → 单页，翻页按钮都禁用
    await page.locator('.sm-pager-select').selectOption('20')
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 1 / 1 页')
    expect(await page.locator('.sm-task').count()).toBe(11)
    expect(await page.locator('.sm-pager-btn').first().isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '下一页' }).isDisabled()).toBe(true)
    // 切回 10 条/页恢复两页
    await page.locator('.sm-pager-select').selectOption('10')
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 1 / 2 页')

    // ⑥ 切到别的空间再回来：回到第 1 页（不被上一空间的分页状态带偏）
    await page.locator('.sm-pager-input').fill('2')
    await page.getByRole('button', { name: '跳转' }).click()
    await spaceRow(wsName2).click()
    await spaceRow(pageWsName).click()
    expect(await page.locator('.sm-pager-indicator').textContent()).toContain('第 1 / 2 页')
  }, 120_000)

  it('分页: 删除末页唯一一条后页码自动回落（不停在空页）', async () => {
    await spaceRow(pageWsName).click()
    await page.locator('.sm-pager-select').selectOption('10')
    await page.locator('.sm-pager-input').fill('2')
    await page.getByRole('button', { name: '跳转' }).click()
    expect(await page.locator('.sm-task').count()).toBe(1)

    await page.locator('.sm-task').first().hover()
    await page.locator('.sm-task-btn--danger').click()
    await page.locator('.ms-mask').waitFor({ state: 'visible', timeout: 5_000 })
    await page.locator('.confirm-btn--danger').click()

    // 10 条 → 仍停在唯一的第 1 页，不会留在空的第 2 页
    await expect
      .poll(() => page.locator('.sm-pager-indicator').textContent(), { timeout: 5_000 })
      .toContain('第 1 / 1 页')
    await expect.poll(() => page.locator('.sm-task').count(), { timeout: 5_000 }).toBe(10)
    expect(await page.locator('.sm-pager-total').textContent()).toContain('共 10 条')
  }, 90_000)

  it('左列: 删除空间 → 确认文案含任务数 → 确认后行与侧栏分组消失', async () => {
    const row = spaceRow(wsName)
    await row.hover()
    await row.locator('.space-row-btn--danger').click()
    await page.locator('.ms-mask').waitFor({ state: 'visible', timeout: 5_000 })
    const message = (await page.locator('.confirm-message').textContent()) ?? ''
    expect(message).toContain('0 个任务')
    expect(message).toContain('确认移除？')
    await page.locator('.confirm-btn--danger').click()

    await expect.poll(() => spaceRow(wsName).count(), { timeout: 5_000 }).toBe(0)
    await expect
      .poll(() => page.locator('.space-group').filter({ hasText: wsName }).count(), {
        timeout: 5_000
      })
      .toBe(0)
  }, 90_000)
})
