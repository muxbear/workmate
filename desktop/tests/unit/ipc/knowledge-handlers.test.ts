import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerKnowledgeHandlers } from '../../../src/main/ipc/knowledge-handlers'
import { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import { KnowledgeSettingsStore } from '../../../src/main/knowledge/KnowledgeSettingsStore'
import type { SessionService } from '../../../src/main/services/SessionService'
import { defaultSettings } from '../../../src/main/settings/schema'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-ipc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    handlers,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return handlers.get(channel)!({} as never, ...args) as T
    }
  }
}

/**
 * 用**真实** service + 临时目录存储测 handler，覆盖「handler → 校验 → 落盘」整条链路；
 * 仅登录态用假 session（未登录场景无法用真实服务构造）。
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createHarness(userId: string | null = 'u1') {
  const store = new KnowledgeSettingsStore(dir)
  const service = new KnowledgeSettingsService(store, {
    getGlobalSettings: () => defaultSettings()
  })
  const session = {
    requireUserId: vi.fn(() => {
      if (userId === null) throw new Error('未登录，请先登录')
      return userId
    })
  }
  const ipc = createFakeIpcMain()
  registerKnowledgeHandlers(ipc as never, {
    knowledgeSettingsService: service,
    session: session as unknown as SessionService
  })
  return { ipc, service }
}

describe('knowledge IPC handlers', () => {
  it('注册 2 个通道', () => {
    const { ipc } = createHarness()
    expect(ipc.handle).toHaveBeenCalledWith('knowledge:get-kb-settings', expect.any(Function))
    expect(ipc.handle).toHaveBeenCalledWith('knowledge:set-kb-settings', expect.any(Function))
    expect(ipc.handlers.size).toBe(2)
  })

  it('set 后 get 拿到已落盘的覆盖项', async () => {
    const { ipc } = createHarness()
    const set = await ipc.invoke<{ success: boolean; data?: unknown }>(
      'knowledge:set-kb-settings',
      'product',
      { chunkSize: 1200, rerankEnabled: false }
    )
    expect(set.success).toBe(true)
    expect(set.data).toEqual({ chunkSize: 1200, rerankEnabled: false })

    const get = await ipc.invoke<{ success: boolean; data?: unknown }>(
      'knowledge:get-kb-settings',
      ['product', 'design']
    )
    expect(get.success).toBe(true)
    expect(get.data).toEqual({ product: { chunkSize: 1200, rerankEnabled: false }, design: {} })
  })

  it('省略 kbIds 时返回该用户全部已配置项', async () => {
    const { ipc } = createHarness()
    await ipc.invoke('knowledge:set-kb-settings', 'product', { topK: 20 })
    const get = await ipc.invoke<{ success: boolean; data?: unknown }>('knowledge:get-kb-settings')
    expect(get.data).toEqual({ product: { topK: 20 } })
  })

  it('set 非法值：返回 { success: false } 且不落盘', async () => {
    const { ipc } = createHarness()
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:set-kb-settings',
      'product',
      { chunkSize: 99999 }
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('chunkSize')
    const after = await ipc.invoke<{ data?: unknown }>('knowledge:get-kb-settings')
    expect(after.data).toEqual({})
  })

  it('set 拒绝非字符串 kbId / 未知配置项', async () => {
    const { ipc } = createHarness()
    const badId = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:set-kb-settings',
      123,
      { chunkSize: 1200 }
    )
    expect(badId.success).toBe(false)
    expect(badId.error).toContain('知识库 ID')

    const badKey = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:set-kb-settings',
      'product',
      { directory: '/tmp' }
    )
    expect(badKey.success).toBe(false)
    expect(badKey.error).toContain('未知的知识库配置项')
  })

  it('get 拒绝非数组 kbIds', async () => {
    const { ipc } = createHarness()
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:get-kb-settings',
      'product'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('kbIds')
  })

  it('未登录：两个通道都返回 { success: false }', async () => {
    const { ipc } = createHarness(null)
    const get = await ipc.invoke<{ success: boolean; error?: string }>('knowledge:get-kb-settings')
    expect(get.success).toBe(false)
    expect(get.error).toContain('未登录')

    const set = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:set-kb-settings',
      'product',
      { chunkSize: 1200 }
    )
    expect(set.success).toBe(false)
    expect(set.error).toContain('未登录')
  })

  it('传 {} 清除该知识库的覆盖项', async () => {
    const { ipc } = createHarness()
    await ipc.invoke('knowledge:set-kb-settings', 'product', { chunkSize: 1200 })
    const cleared = await ipc.invoke<{ success: boolean; data?: unknown }>(
      'knowledge:set-kb-settings',
      'product',
      {}
    )
    expect(cleared.success).toBe(true)
    expect(cleared.data).toEqual({})
    const get = await ipc.invoke<{ data?: unknown }>('knowledge:get-kb-settings')
    expect(get.data).toEqual({})
  })
})
