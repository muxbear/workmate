import { describe, expect, it, vi } from 'vitest'
import { registerExpertSyncHandlers } from '../../../src/main/ipc/expert-sync-handlers'

function createFakeIpcMain(): {
  handle: ReturnType<typeof vi.fn>
  handlers: Map<string, (...args: unknown[]) => unknown>
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
} {
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

interface HandlerDeps {
  expertSyncService: {
    getStatus: ReturnType<typeof vi.fn>
    authorize: ReturnType<typeof vi.fn>
    sync: ReturnType<typeof vi.fn>
    loadLocal: ReturnType<typeof vi.fn>
    deleteExpert: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }
  session: { requireUserId: ReturnType<typeof vi.fn> }
}

function createDeps(overrides: Record<string, unknown> = {}): HandlerDeps {
  return {
    expertSyncService: {
      getStatus: vi.fn(() => ({ status: 'authorized', webUser: null })),
      authorize: vi.fn(async () => ({ webUser: null })),
      sync: vi.fn(async () => ({
        experts: [],
        syncedAt: 1,
        stats: { added: 0, updated: 0, kept: 0 }
      })),
      loadLocal: vi.fn(async () => null),
      deleteExpert: vi.fn(async () => ({ experts: [], syncedAt: 111 })),
      disconnect: vi.fn(async () => undefined)
    },
    session: { requireUserId: vi.fn(() => 'u1') },
    ...overrides
  } as unknown as HandlerDeps
}

describe('expert-sync IPC handlers', () => {
  it('ESH-01: 注册状态 / 授权 / 同步 / 读本地 / 删除 / 断开通道', () => {
    const ipc = createFakeIpcMain()
    registerExpertSyncHandlers(ipc as never, createDeps() as never)
    for (const channel of [
      'expert-sync:status',
      'expert-sync:authorize',
      'expert-sync:sync',
      'expert-sync:load-local',
      'expert-sync:delete-expert',
      'expert-sync:disconnect'
    ]) {
      expect(ipc.handlers.has(channel)).toBe(true)
    }
  })

  it('ESH-02: delete-expert 经会话校验后透传专家 id 并返回剩余列表', async () => {
    const deps = createDeps()
    deps.expertSyncService.deleteExpert.mockResolvedValue({
      experts: [{ id: 'e2' }],
      syncedAt: 111
    })
    const ipc = createFakeIpcMain()
    registerExpertSyncHandlers(ipc as never, deps as never)

    const result = await ipc.invoke<{ success: boolean; data: { syncedAt: number } }>(
      'expert-sync:delete-expert',
      'e1'
    )

    expect(deps.session.requireUserId).toHaveBeenCalledTimes(1)
    expect(deps.expertSyncService.deleteExpert).toHaveBeenCalledWith('e1')
    expect(result.success).toBe(true)
    expect(result.data.syncedAt).toBe(111)
  })

  it('ESH-03: delete-expert 入参非法时直接失败，不触碰服务与会话', async () => {
    const deps = createDeps()
    const ipc = createFakeIpcMain()
    registerExpertSyncHandlers(ipc as never, deps as never)

    for (const invalid of [undefined, null, '', '   ', 123, { id: 'e1' }, 'x'.repeat(129)]) {
      const result = await ipc.invoke<{ success: boolean; error: string }>(
        'expert-sync:delete-expert',
        invalid
      )
      expect(result.success).toBe(false)
      expect(result.error).toBe('参数错误：专家 id 无效')
    }
    expect(deps.expertSyncService.deleteExpert).not.toHaveBeenCalled()
    expect(deps.session.requireUserId).not.toHaveBeenCalled()
  })

  it('ESH-04: delete-expert 服务出错时回传错误信息（如本地文件缺失）', async () => {
    const deps = createDeps()
    deps.expertSyncService.deleteExpert.mockRejectedValue(new Error('本地专家数据不存在，请先同步'))
    const ipc = createFakeIpcMain()
    registerExpertSyncHandlers(ipc as never, deps as never)

    const result = await ipc.invoke<{ success: boolean; error: string }>(
      'expert-sync:delete-expert',
      'e1'
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('本地专家数据不存在，请先同步')
  })
})
