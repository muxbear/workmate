import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerKnowledgeHandlers } from '../../../src/main/ipc/knowledge-handlers'
import { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import { KnowledgeSettingsStore } from '../../../src/main/knowledge/KnowledgeSettingsStore'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeService } from '../../../src/main/knowledge/KnowledgeService'
import type { SessionService } from '../../../src/main/services/SessionService'
import { defaultSettings } from '../../../src/main/settings/schema'

let dir: string
/** 打开的索引库连接（Windows 下不关闭会锁住 index.db，导致临时目录删不掉） */
let openStores: KnowledgeStore[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-ipc-'))
  openStores = []
})

afterEach(() => {
  for (const store of openStores) store.close()
  openStores = []
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
  const knowledgeStore = new KnowledgeStore(() => dir)
  openStores.push(knowledgeStore)
  const knowledgeFileService = new KnowledgeFileService(knowledgeStore, {
    getDir: () => dir,
    getLimits: () => ({
      maxUploadSizeMB: 100,
      maxFilesPerBatch: 20,
      uploadTimeoutMinutes: 10
    })
  })
  const knowledgeService = new KnowledgeService(knowledgeStore, knowledgeFileService)
  const session = {
    requireUserId: vi.fn(() => {
      if (userId === null) throw new Error('未登录，请先登录')
      return userId
    })
  }
  const ipc = createFakeIpcMain()
  registerKnowledgeHandlers(ipc as never, {
    knowledgeSettingsService: service,
    knowledgeService,
    session: session as unknown as SessionService
  })
  return { ipc, service, knowledgeService, knowledgeStore }
}

/** 造一个真实源文件用于导入 */
function makeSourceFile(name: string, content = 'hello'): string {
  const file = join(dir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

describe('knowledge IPC handlers', () => {
  it('注册全部通道（配置 2 个 + 知识库本体 13 个）', () => {
    const { ipc } = createHarness()
    for (const channel of [
      'knowledge:get-kb-settings',
      'knowledge:set-kb-settings',
      'knowledge:list-kbs',
      'knowledge:create-kb',
      'knowledge:update-kb',
      'knowledge:delete-kb',
      'knowledge:stats',
      'knowledge:list-docs',
      'knowledge:import',
      'knowledge:rename-doc',
      'knowledge:remove-doc',
      'knowledge:read-file',
      'knowledge:create-share',
      'knowledge:list-shares',
      'knowledge:revoke-share'
    ]) {
      expect(ipc.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
    expect(ipc.handlers.size).toBe(15)
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

  it('知识库 CRUD：create → list → update → delete', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ success: boolean; data?: { id: string; name: string } }>(
      'knowledge:create-kb',
      { name: '产品资料库', description: '需求与用户研究', kind: 'local' }
    )
    expect(created.success).toBe(true)
    const kbId = created.data!.id

    const listed = await ipc.invoke<{ data: Array<{ id: string }> }>('knowledge:list-kbs')
    expect(listed.data.map((row) => row.id)).toEqual([kbId])

    const renamed = await ipc.invoke<{ success: boolean; data?: { name: string } }>(
      'knowledge:update-kb',
      kbId,
      { name: '产品资料库 V2' }
    )
    expect(renamed.data?.name).toBe('产品资料库 V2')

    const removed = await ipc.invoke<{ success: boolean; data?: { removedDocs: number } }>(
      'knowledge:delete-kb',
      kbId
    )
    expect(removed.success).toBe(true)
    expect(removed.data?.removedDocs).toBe(0)
    const after = await ipc.invoke<{ data: unknown[] }>('knowledge:list-kbs')
    expect(after.data).toEqual([])
  })

  it('create 重名：返回 { success: false }', async () => {
    const { ipc } = createHarness()
    await ipc.invoke('knowledge:create-kb', { name: '同名库' })
    const again = await ipc.invoke<{ success: boolean; error?: string }>('knowledge:create-kb', {
      name: '同名库'
    })
    expect(again.success).toBe(false)
    expect(again.error).toContain('已存在')
  })

  it('import → list-docs → rename → remove（真实落盘）', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '导入测试库'
    })
    const kbId = created.data.id

    const imported = await ipc.invoke<{
      success: boolean
      data: { accepted: Array<{ relPath: string }>; skipped: unknown[]; failed: unknown[] }
    }>('knowledge:import', kbId, [
      { srcPath: makeSourceFile('需求说明.md', '# 需求'), relPath: '文档/需求说明.md' }
    ])
    expect(imported.success).toBe(true)
    expect(imported.data.accepted.map((doc) => doc.relPath)).toEqual(['文档/需求说明.md'])

    const docs = await ipc.invoke<{ data: Array<{ relPath: string; indexState: string }> }>(
      'knowledge:list-docs',
      kbId
    )
    expect(docs.data).toHaveLength(1)
    expect(docs.data[0].indexState).toBe('none')

    const renamed = await ipc.invoke<{ data: { relPath: string } }>(
      'knowledge:rename-doc',
      kbId,
      '文档/需求说明.md',
      '需求说明-终稿.md'
    )
    expect(renamed.data.relPath).toBe('文档/需求说明-终稿.md')

    const read = await ipc.invoke<{ data: { content?: string } }>(
      'knowledge:read-file',
      kbId,
      '文档/需求说明-终稿.md',
      'text'
    )
    expect(read.data.content).toContain('需求')

    const removed = await ipc.invoke<{ data: { removed: number } }>(
      'knowledge:remove-doc',
      kbId,
      '文档'
    )
    expect(removed.data.removed).toBe(1)
    const after = await ipc.invoke<{ data: unknown[] }>('knowledge:list-docs', kbId)
    expect(after.data).toEqual([])
  })

  it('import 索引方式非 none：明确报错（索引能力未开放）', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '索引测试库'
    })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('a.md'), relPath: 'a.md' }],
      'default'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('索引功能尚未开放')
  })

  it('路径越界（../）被拒绝', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '越界测试库'
    })
    const result = await ipc.invoke<{ data: { failed: Array<{ reason: string }> } }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('b.md'), relPath: '../../etc/passwd' }]
    )
    expect(result.data.failed[0].reason).toContain('非法')
  })

  it('共享：create-share → list-shares → revoke-share', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '共享测试库'
    })
    const share = await ipc.invoke<{ success: boolean; data: { token: string; url: string } }>(
      'knowledge:create-share',
      {
        targetKind: 'library',
        targetId: created.data.id,
        targetName: '共享测试库'
      }
    )
    expect(share.success).toBe(true)
    expect(share.data.url.startsWith('ke-work://share/')).toBe(true)

    const list = await ipc.invoke<{ data: unknown[] }>('knowledge:list-shares')
    expect(list.data).toHaveLength(1)

    const revoked = await ipc.invoke<{ data: { revoked: boolean } }>(
      'knowledge:revoke-share',
      share.data.token
    )
    expect(revoked.data.revoked).toBe(true)
    const after = await ipc.invoke<{ data: unknown[] }>('knowledge:list-shares')
    expect(after.data).toEqual([])
  })

  it('未登录：知识库本体通道同样返回 { success: false }', async () => {
    const { ipc } = createHarness(null)
    const list = await ipc.invoke<{ success: boolean; error?: string }>('knowledge:list-kbs')
    expect(list.success).toBe(false)
    expect(list.error).toContain('未登录')

    const create = await ipc.invoke<{ success: boolean; error?: string }>('knowledge:create-kb', {
      name: 'x'
    })
    expect(create.success).toBe(false)
    expect(create.error).toContain('未登录')
  })
})
