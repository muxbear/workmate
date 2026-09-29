import { describe, expect, it, vi } from 'vitest'
import { registerAutomationTemplateSyncHandlers } from '../../../src/main/ipc/automation-template-sync-handlers'
import type { AutomationTemplateSyncProgress } from '../../../src/preload/index.d'

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

interface FakeEvent {
  sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
}

function createFakeEvent(): FakeEvent {
  return { sender: { isDestroyed: () => false, send: vi.fn() } }
}

interface HandlerDeps {
  automationTemplateSyncService: {
    getStatus: ReturnType<typeof vi.fn>
    authorize: ReturnType<typeof vi.fn>
    sync: ReturnType<typeof vi.fn>
    loadLocal: ReturnType<typeof vi.fn>
    deleteTemplate: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }
  session: { requireUserId: ReturnType<typeof vi.fn> }
}

function createDeps(overrides: Record<string, unknown> = {}): HandlerDeps {
  return {
    automationTemplateSyncService: {
      getStatus: vi.fn(() => ({ status: 'authorized', webUser: null })),
      authorize: vi.fn(async () => ({ webUser: null })),
      sync: vi.fn(async () => ({
        templates: [],
        syncedAt: 1,
        stats: { added: 0, updated: 0, kept: 0 }
      })),
      loadLocal: vi.fn(async () => null),
      deleteTemplate: vi.fn(async () => ({ templates: [], syncedAt: 111 })),
      disconnect: vi.fn(async () => undefined)
    },
    session: { requireUserId: vi.fn(() => 'u1') },
    ...overrides
  } as unknown as HandlerDeps
}

describe('automation-template-sync IPC handlers', () => {
  it('ATSH-01: 注册状态 / 授权 / 同步 / 读本地 / 删除 / 断开通道', () => {
    const ipc = createFakeIpcMain()
    registerAutomationTemplateSyncHandlers(ipc as never, createDeps() as never)
    for (const channel of [
      'automation-template-sync:status',
      'automation-template-sync:authorize',
      'automation-template-sync:sync',
      'automation-template-sync:load-local',
      'automation-template-sync:delete-template',
      'automation-template-sync:disconnect'
    ]) {
      expect(ipc.handlers.has(channel)).toBe(true)
    }
  })

  it('ATSH-02: delete-template 经会话校验后透传模板 id 并返回剩余列表', async () => {
    const deps = createDeps()
    deps.automationTemplateSyncService.deleteTemplate.mockResolvedValue({
      templates: [{ id: 't2' }],
      syncedAt: 111
    })
    const ipc = createFakeIpcMain()
    registerAutomationTemplateSyncHandlers(ipc as never, deps as never)

    const result = await ipc.invoke<{ success: boolean; data: { syncedAt: number } }>(
      'automation-template-sync:delete-template',
      't1'
    )

    expect(deps.session.requireUserId).toHaveBeenCalledTimes(1)
    expect(deps.automationTemplateSyncService.deleteTemplate).toHaveBeenCalledWith('t1')
    expect(result.success).toBe(true)
    expect(result.data.syncedAt).toBe(111)
  })

  it('ATSH-03: delete-template 入参非法时直接失败，不触碰服务与会话', async () => {
    const deps = createDeps()
    const ipc = createFakeIpcMain()
    registerAutomationTemplateSyncHandlers(ipc as never, deps as never)

    for (const invalid of [undefined, null, '', '   ', 123, { id: 't1' }, 'x'.repeat(129)]) {
      const result = await ipc.invoke<{ success: boolean; error: string }>(
        'automation-template-sync:delete-template',
        invalid
      )
      expect(result.success).toBe(false)
      expect(result.error).toBe('参数错误：模板 id 无效')
    }
    expect(deps.automationTemplateSyncService.deleteTemplate).not.toHaveBeenCalled()
    expect(deps.session.requireUserId).not.toHaveBeenCalled()
  })

  it('ATSH-04: delete-template 服务出错时回传错误信息（如本地文件缺失）', async () => {
    const deps = createDeps()
    deps.automationTemplateSyncService.deleteTemplate.mockRejectedValue(
      new Error('本地定时模板不存在，请先同步')
    )
    const ipc = createFakeIpcMain()
    registerAutomationTemplateSyncHandlers(ipc as never, deps as never)

    const result = await ipc.invoke<{ success: boolean; error: string }>(
      'automation-template-sync:delete-template',
      't1'
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('本地定时模板不存在，请先同步')
  })

  it('ATSH-05: sync 把进度事件推给 sender，失败时补推 error 阶段', async () => {
    const deps = createDeps()
    const event = createFakeEvent()
    const ipc = createFakeIpcMain()
    registerAutomationTemplateSyncHandlers(ipc as never, deps as never)

    // 成功：服务内部回调驱动的进度由服务负责，这里只验失败兜底
    await ipc.handlers.get('automation-template-sync:sync')!(event)
    expect(event.sender.send).not.toHaveBeenCalled()

    deps.automationTemplateSyncService.sync.mockRejectedValue(new Error('授权失败'))
    const result = await ipc.handlers.get('automation-template-sync:sync')!(event) as {
      success: boolean
      error: string
    }
    const progress = event.sender.send.mock.calls.at(-1)![1] as AutomationTemplateSyncProgress

    expect(result.success).toBe(false)
    expect(result.error).toBe('授权失败')
    expect(progress.phase).toBe('error')
    expect(progress.message).toBe('授权失败')
  })
})
