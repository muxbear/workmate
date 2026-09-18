/**
 * E2E：统一 OAuth2 授权（一次授权复用 + 关闭后增量授权）。
 *
 * 流程：云端工作登录（默认全开授权一次）→ 通过渲染层桥接调用专家 / 技能同步 →
 * 依据 mock 服务的授权统计断言：
 * - 默认全开时全程只完成一次授权（不重复弹授权页）；
 * - 授权页关闭 skill:read 后，专家同步静默复用，只有技能同步发起增量授权且只申请缺失项。
 *
 * 前置：npm run build（生成 out/）；无需真实 Web 后端。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getMockStats,
  resetMockState,
  setMockDeniedScopes,
  startMockOAuthServer,
  stopMockOAuthServer
} from './mock-oauth-server'

const APP_ENTRY = join(process.cwd(), 'out', 'main', 'index.js')
const WAIT = 30_000
const MOCK_PORT = 8011

type LaunchApp = Awaited<ReturnType<typeof electron.launch>>
type AppPage = Awaited<ReturnType<LaunchApp['firstWindow']>>

interface BridgeResult {
  success: boolean
  error?: string
}

/** 通过渲染层桥接调用专家同步（避开侧边栏导航细节） */
async function syncExpert(page: AppPage): Promise<BridgeResult> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { expert: { sync(): Promise<{ success: boolean; error?: string }> } }
      }
    ).api
    return api.expert.sync()
  })
}

/** 通过渲染层桥接调用技能同步 */
async function syncSkill(page: AppPage): Promise<BridgeResult> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { skillSync: { sync(): Promise<{ success: boolean; error?: string }> } }
      }
    ).api
    return api.skillSync.sync()
  })
}

/**
 * 启动应用 → 云端工作 OAuth 登录 → 执行用例主体 → 清理临时目录与 mock 状态。
 * deniedScopes 模拟用户在授权页关闭的权限。
 */
async function runScenario(
  deniedScopes: string[],
  body: (page: AppPage) => Promise<void>
): Promise<void> {
  resetMockState()
  setMockDeniedScopes(deniedScopes)
  const dataHome = mkdtempSync(join(tmpdir(), 'kw-oauth-single-'))
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
    await body(page)
  } finally {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5_000))])
    try {
      app.process().kill()
    } catch {
      // 进程已退出
    }
    rmSync(dataHome, { recursive: true, force: true })
    resetMockState()
  }
}

describe('E2E 统一 OAuth2 授权', () => {
  beforeAll(async () => {
    await startMockOAuthServer(MOCK_PORT)
  })

  afterAll(async () => {
    await stopMockOAuthServer()
  })

  it(
    'E2E-OAUTH-02: 默认全开授权一次后，专家 / 技能同步静默复用',
    async () => {
      await runScenario([], async (page) => {
        const afterLogin = getMockStats()
        expect(afterLogin.tokenRequests).toBe(1)
        expect(afterLogin.authorizationRequests).toHaveLength(1)
        for (const scope of ['skill:read', 'expert:read', 'model:read', 'user:read']) {
          expect(afterLogin.grantedScopes).toContain(scope)
        }

        expect((await syncExpert(page)).success).toBe(true)
        expect((await syncSkill(page)).success).toBe(true)

        const afterSync = getMockStats()
        expect(afterSync.tokenRequests).toBe(1)
        expect(afterSync.authorizationRequests).toHaveLength(1)
      })
    },
    180_000
  )

  it(
    'E2E-OAUTH-03: 授权页关闭 skill:read 后，仅技能同步发起增量授权',
    async () => {
      await runScenario(['skill:read'], async (page) => {
        const afterLogin = getMockStats()
        expect(afterLogin.tokenRequests).toBe(1)
        expect(afterLogin.grantedScopes).toContain('expert:read')
        expect(afterLogin.grantedScopes).not.toContain('skill:read')

        // 专家同步：expert:read 已授权 → 不打开授权页
        expect((await syncExpert(page)).success).toBe(true)
        expect(getMockStats().tokenRequests).toBe(1)

        // 技能同步：skill:read 缺失 → 触发增量授权，且只申请缺失项
        expect((await syncSkill(page)).success).toBe(true)
        const afterSkillSync = getMockStats()
        expect(afterSkillSync.tokenRequests).toBe(2)
        expect(afterSkillSync.authorizationRequests).toHaveLength(2)
        expect(afterSkillSync.authorizationRequests[1]).toBe('skill:read')
      })
    },
    180_000
  )
})
