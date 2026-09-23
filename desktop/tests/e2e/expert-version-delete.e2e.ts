/**
 * E2E：专家版本比对同步 + 本地删除。
 *
 * 覆盖两条需求：
 * 1. 同步时逐个比对版本：服务端更高才覆盖本地，本地更高则保留；
 * 2. 卡片删除（二次确认）只删本机副本，再次同步会按服务端版本重新拉回。
 *
 * 前置：npm run build（生成 out/）；无需真实 Web 后端与真实账号。
 * 本地 experts.json 预置在临时 KE_WORK_HOME 下，隔离真实用户目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetMockState,
  setMockExperts,
  startMockOAuthServer,
  stopMockOAuthServer
} from './mock-oauth-server'
import type { DesktopExpert } from '../../src/preload/index.d'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000
const MOCK_PORT = 8013

type LaunchApp = Awaited<ReturnType<typeof electron.launch>>
type AppPage = Awaited<ReturnType<LaunchApp['firstWindow']>>

/** 本地预置专家（模拟上一次同步落盘的副本） */
function localExpert(id: string, name: string, version: string): DesktopExpert {
  return {
    id,
    name,
    title: '本地标题',
    tags: ['本地标签'],
    desc: '本地描述',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: 'Zap',
    category: '全部',
    rating: 4.9,
    users: '2.3k',
    initials: name.charAt(0),
    systemPrompt: '',
    tools: [],
    providerId: null,
    modelId: null,
    modelName: null,
    modelType: null,
    skills: [],
    mcpConfigs: [],
    promptTemplate: '',
    expertiseAreas: [],
    version,
    isExpert: true
  }
}

/** 服务端下发的专家项（ExpertSyncItem 形态） */
function serverExpert(id: string, name: string, version: string): Record<string, unknown> {
  return {
    id,
    name,
    title: '服务端标题',
    desc: '服务端描述',
    category: '全部',
    tags: ['服务端标签'],
    color: '',
    initials: name.charAt(0),
    icon: '',
    avatar_url: null,
    rating: 4.9,
    users: '2.3k',
    system_prompt: '',
    scene: null,
    sort_order: 0,
    provider_id: null,
    model_id: null,
    model_name: null,
    model_type: null,
    tools: [],
    skills: [],
    mcp_configs: [],
    prompt_template: '',
    expertise_areas: [],
    version
  }
}

/** 预置本地 experts.json（桌面端同步的目标文件） */
function writeLocalExperts(dataHome: string, experts: DesktopExpert[]): void {
  const dir = join(dataHome, 'experts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'experts.json'),
    JSON.stringify({ version: 1, syncedAt: 111, syncedBy: null, experts }, null, 2),
    'utf-8'
  )
}

function readLocalExperts(dataHome: string): DesktopExpert[] {
  const raw = JSON.parse(readFileSync(join(dataHome, 'experts', 'experts.json'), 'utf-8'))
  return raw.experts as DesktopExpert[]
}

/** 启动应用 → OAuth 登录 → 打开「专家」页面 → 执行用例主体 */
async function runExpertPage(
  dataHome: string,
  body: (page: AppPage) => Promise<void>
): Promise<void> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    KE_WORK_HOME: dataHome,
    KE_WORK_USER_DATA: join(dataHome, 'user-data'),
    WORKMATE_WEB_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`
  })

  const app = await electron.launch({ args: [APP_ENTRY], env })
  try {
    const page = await app.firstWindow()
    await page.locator('.login-card').waitFor({ state: 'visible', timeout: WAIT })
    await page.getByText('云端工作').click()
    await page.locator('.oauth-panel').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: '同意并登录' }).click()
    await page.locator('.home-layout').waitFor({ state: 'visible', timeout: WAIT })

    // 侧栏「智能体」分组默认收起，展开后进入「专家」页面
    await page.locator('.nav-item--group', { hasText: '智能体' }).click()
    await page.locator('.nav-item--sub', { hasText: '专家' }).click()
    await page.locator('.expert-page').waitFor({ state: 'visible', timeout: WAIT })
    await body(page)
  } finally {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5_000))])
    try {
      app.process().kill()
    } catch {
      // 进程已退出
    }
  }
}

/** 定位指定专家卡片 */
function cardOf(page: AppPage, name: string): ReturnType<AppPage['locator']> {
  return page.locator('.expert-card', { hasText: name })
}

/** 卡片内某元素文本（模板折行会带入空白，统一 trim 后断言） */
async function textOf(page: AppPage, name: string, selector: string): Promise<string> {
  const text = await cardOf(page, name).locator(selector).textContent()
  return (text ?? '').trim()
}

describe('E2E 专家版本同步与本地删除', () => {
  beforeAll(async () => {
    await startMockOAuthServer(MOCK_PORT)
  })

  afterAll(async () => {
    await stopMockOAuthServer()
  })

  it('E2E-EXPERT-01: 同步只更新版本更高的专家；删除后再次同步可拉回', async () => {
    resetMockState()
    const dataHome = mkdtempSync(join(tmpdir(), 'kw-expert-e2e-'))
    // 本地：甲 1.0.0（服务端 1.0.1，应更新）、乙 9.9.9（服务端 1.0.1，应保留）
    writeLocalExperts(dataHome, [
      localExpert('e-a', '甲专家', '1.0.0'),
      localExpert('e-b', '乙专家', '9.9.9')
    ])
    setMockExperts([serverExpert('e-a', '甲专家', '1.0.1'), serverExpert('e-b', '乙专家', '1.0.1')])

    try {
      await runExpertPage(dataHome, async (page) => {
        // 初始渲染：版本徽标来自本地副本
        expect(await textOf(page, '甲专家', '.expert-version')).toBe('v1.0.0')

        // ① 同步：版本比对（甲更新到 1.0.1，乙保留本地 9.9.9）
        await page.locator('.sync-btn').click()
        await page.locator('.expert-toast').waitFor({ state: 'visible', timeout: WAIT })
        const toast = (await page.locator('.expert-toast').textContent()) ?? ''
        expect(toast).toContain('更新 1 个')
        expect(toast).toContain('保留本地 1 个')

        expect(await textOf(page, '甲专家', '.expert-version')).toBe('v1.0.1')
        expect(await textOf(page, '乙专家', '.expert-version')).toBe('v9.9.9')
        // 乙专家保留本地内容（服务端标题未覆盖本地标题）
        expect(await textOf(page, '乙专家', '.expert-title')).toBe('本地标题')
        expect(readLocalExperts(dataHome).map((e) => `${e.id}@${e.version}`)).toEqual([
          'e-a@1.0.1',
          'e-b@9.9.9'
        ])

        // ② 删除：二次确认 → 取消不删
        await cardOf(page, '甲专家').hover()
        await cardOf(page, '甲专家').locator('.expert-delete-btn').click()
        await page.locator('.confirm-card').waitFor({ state: 'visible', timeout: 5_000 })
        expect((await page.locator('.confirm-message').textContent()) ?? '').toContain(
          '仅从本机移除'
        )
        await page.locator('.confirm-btn--cancel').click()
        await page.locator('.confirm-card').waitFor({ state: 'hidden', timeout: 5_000 })
        expect(await page.locator('.expert-card').count()).toBe(2)

        // ③ 删除：确认 → 卡片消失、磁盘少一条、其余保留
        await cardOf(page, '甲专家').hover()
        await cardOf(page, '甲专家').locator('.expert-delete-btn').click()
        await page.locator('.confirm-btn--danger').click()
        await page.locator('.expert-toast').waitFor({ state: 'visible', timeout: 5_000 })
        expect(await page.locator('.expert-card').count()).toBe(1)
        expect(await page.locator('.expert-card', { hasText: '乙专家' }).count()).toBe(1)
        expect(readLocalExperts(dataHome).map((e) => e.id)).toEqual(['e-b'])

        // ④ 再次同步：被删专家按服务端版本重新拉回（需求 2 闭环）
        await page.locator('.sync-btn').click()
        await page.locator('.expert-card', { hasText: '甲专家' }).waitFor({
          state: 'visible',
          timeout: WAIT
        })
        expect(await textOf(page, '甲专家', '.expert-version')).toBe('v1.0.1')
        expect(
          readLocalExperts(dataHome)
            .map((e) => e.id)
            .sort()
        ).toEqual(['e-a', 'e-b'])
      })
    } finally {
      rmSync(dataHome, { recursive: true, force: true })
      resetMockState()
    }
  }, 120_000)
})
