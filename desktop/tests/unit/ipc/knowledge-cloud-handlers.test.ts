import { describe, expect, it, vi } from 'vitest'

import {
  CLOUD_KNOWLEDGE_CHANNELS,
  registerCloudKnowledgeHandlers
} from '../../../src/main/ipc/knowledge-cloud-handlers'
import { CloudAuthRequiredError } from '../../../src/main/knowledge/CloudKnowledgeService'

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
  cloudKnowledgeService: {
    getStatus: ReturnType<typeof vi.fn>
    listBases: ReturnType<typeof vi.fn>
    listInvitations: ReturnType<typeof vi.fn>
    respondInvitation: ReturnType<typeof vi.fn>
    getBase: ReturnType<typeof vi.fn>
    listDocuments: ReturnType<typeof vi.fn>
    readDocument: ReturnType<typeof vi.fn>
    saveDocumentAs: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }
  session: { requireUserId: ReturnType<typeof vi.fn> }
  chooseSavePath: ReturnType<typeof vi.fn>
}

function createDeps(overrides: Record<string, unknown> = {}): HandlerDeps {
  return {
    cloudKnowledgeService: {
      getStatus: vi.fn(() => ({ linked: true, hasScope: true })),
      listBases: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })),
      listInvitations: vi.fn(async () => []),
      respondInvitation: vi.fn(async () => undefined),
      getBase: vi.fn(async () => ({ id: 'kb-1' })),
      listDocuments: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })),
      readDocument: vi.fn(async () => ({ content: 'x', ext: 'md', name: 'a.md' })),
      saveDocumentAs: vi.fn(async () => undefined),
      disconnect: vi.fn(() => undefined)
    },
    session: { requireUserId: vi.fn(() => 'u1') },
    chooseSavePath: vi.fn(async () => null),
    ...overrides
  } as unknown as HandlerDeps
}

function register(deps: HandlerDeps = createDeps()): {
  ipc: ReturnType<typeof createFakeIpcMain>
  deps: HandlerDeps
} {
  const ipc = createFakeIpcMain()
  registerCloudKnowledgeHandlers(ipc as never, deps as never)
  return { ipc, deps }
}

describe('云知识库 IPC handlers', () => {
  it('KCH-01: 注册全部云知识库通道', () => {
    const { ipc } = register()
    for (const channel of CLOUD_KNOWLEDGE_CHANNELS) {
      expect(ipc.handlers.has(channel)).toBe(true)
    }
  })

  it('KCH-02: 未登录时列表类通道返回 error 状态而不是抛错', async () => {
    const { ipc } = register(
      createDeps({
        session: {
          requireUserId: vi.fn(() => {
            throw new Error('未登录')
          })
        }
      })
    )

    const result = await ipc.invoke<{ success: boolean; data: { state: string; message: string } }>(
      'knowledge-cloud:list',
      { scope: 'personal' }
    )

    expect(result.success).toBe(true)
    expect(result.data.state).toBe('error')
    expect(result.data.message).toContain('未登录')
  })

  it('KCH-03: 参数非法直接 fail，且不调用服务（scope 白名单 / 页码 / 页大小）', async () => {
    const { ipc, deps } = register()

    const badScope = await ipc.invoke<{ success: boolean }>('knowledge-cloud:list', {
      scope: 'all'
    })
    const badPage = await ipc.invoke<{ success: boolean }>('knowledge-cloud:list', {
      scope: 'personal',
      page: 0
    })
    const badSize = await ipc.invoke<{ success: boolean }>('knowledge-cloud:list', {
      scope: 'personal',
      pageSize: 0
    })

    expect(badScope.success).toBe(false)
    expect(badPage.success).toBe(false)
    expect(badSize.success).toBe(false)
    expect(deps.cloudKnowledgeService.listBases).not.toHaveBeenCalled()
  })

  it('KCH-04: 页大小超过 100 被夹取后传给服务', async () => {
    const { ipc, deps } = register()

    await ipc.invoke('knowledge-cloud:list', { scope: 'public', pageSize: 500 })

    expect(deps.cloudKnowledgeService.listBases).toHaveBeenCalledWith('u1', 'public', {
      page: 1,
      pageSize: 100,
      search: undefined
    })
  })

  it('KCH-05: 缺授权时返回 auth-required（仍是 ok，渲染层据此给「去授权」入口）', async () => {
    const deps = createDeps()
    deps.cloudKnowledgeService.listBases.mockRejectedValue(
      new CloudAuthRequiredError('需要授予 knowledge:read')
    )
    const { ipc } = register(deps)

    const result = await ipc.invoke<{ success: boolean; data: { state: string; message: string } }>(
      'knowledge-cloud:list',
      { scope: 'personal' }
    )

    expect(result.success).toBe(true)
    expect(result.data.state).toBe('auth-required')
    expect(result.data.message).toContain('knowledge:read')
  })

  it('KCH-06: 读取原文要求 as 合法，非法直接 fail 且不调用服务', async () => {
    const { ipc, deps } = register()

    const result = await ipc.invoke<{ success: boolean; error: string }>(
      'knowledge-cloud:read-file',
      'kb-1',
      'doc-1',
      'raw'
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('读取方式非法')
    expect(deps.cloudKnowledgeService.readDocument).not.toHaveBeenCalled()
  })

  it('KCH-07: 另存为在用户取消时返回 saved=false（不报错）', async () => {
    const { ipc } = register(createDeps({ chooseSavePath: vi.fn(async () => null) }))

    const result = await ipc.invoke<{ success: boolean; data: { saved: boolean } }>(
      'knowledge-cloud:download-doc',
      'kb-1',
      'doc-1',
      '规范.md'
    )

    expect(result.success).toBe(true)
    expect(result.data.saved).toBe(false)
  })

  it('KCH-08: 另存为成功后写盘并回传路径', async () => {
    const deps = createDeps({
      chooseSavePath: vi.fn(async () => '/tmp/choose/规范.md')
    })
    const { ipc } = register(deps)

    const result = await ipc.invoke<{ success: boolean; data: { saved: boolean; path: string } }>(
      'knowledge-cloud:download-doc',
      'kb-1',
      'doc-1',
      '规范.md'
    )

    expect(result.data).toEqual({ saved: true, path: '/tmp/choose/规范.md' })
    expect(deps.cloudKnowledgeService.saveDocumentAs).toHaveBeenCalledWith(
      'u1',
      'kb-1',
      'doc-1',
      '/tmp/choose/规范.md'
    )
  })

  it('KCH-09: disconnect 清缓存', async () => {
    const { ipc, deps } = register()

    await ipc.invoke('knowledge-cloud:disconnect')

    expect(deps.cloudKnowledgeService.disconnect).toHaveBeenCalled()
  })
})
