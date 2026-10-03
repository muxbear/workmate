import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerKnowledgeHandlers } from '../../../src/main/ipc/knowledge-handlers'
import { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import { KnowledgeSettingsStore } from '../../../src/main/knowledge/KnowledgeSettingsStore'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'
import { KnowledgeService } from '../../../src/main/knowledge/KnowledgeService'
import { KnowledgeIndexService } from '../../../src/main/knowledge/KnowledgeIndexService'
import { RetrievalService } from '../../../src/main/knowledge/RetrievalService'
import { SparseIndexer } from '../../../src/main/knowledge/SparseIndexer'
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
  // 索引服务用桩：单测只验证「入队/取消被正确调用」，真实索引链路由集成测试覆盖
  const indexer = {
    enqueue: vi.fn(() => ({ queued: 1 })),
    cancel: vi.fn(() => ({ canceled: 1 })),
    pendingCount: vi.fn(() => 0),
    isActive: vi.fn(() => false),
    recoverOnStartup: vi.fn(() => 0),
    dispose: vi.fn()
  }
  const sparseIndexer = new SparseIndexer(knowledgeStore)
  const retrieval = new RetrievalService({
    store: knowledgeStore,
    sparse: sparseIndexer,
    settings: service,
    getGlobalSettings: () => defaultSettings()
  })
  const knowledgeService = new KnowledgeService(knowledgeStore, knowledgeFileService, {
    indexer: indexer as unknown as KnowledgeIndexService,
    retrieval
  })
  const session = {
    requireUserId: vi.fn(() => {
      if (userId === null) throw new Error('未登录，请先登录')
      return userId
    })
  }
  const ipc = createFakeIpcMain()
  // 打开文件夹：用桩记录主进程解析出的路径，避免单测真的弹资源管理器
  const openedDirs: string[] = []
  const revealedFiles: string[] = []
  registerKnowledgeHandlers(ipc as never, {
    knowledgeSettingsService: service,
    knowledgeService,
    session: session as unknown as SessionService,
    getGlobalSettings: () => defaultSettings(),
    openDir: async (target) => {
      openedDirs.push(target)
      return ''
    },
    showItemInFolder: (file) => {
      revealedFiles.push(file)
    }
  })
  return {
    ipc,
    service,
    knowledgeService,
    knowledgeStore,
    indexService: indexer,
    sparseIndexer,
    openedDirs,
    revealedFiles
  }
}

/** 造一个真实源文件用于导入 */
function makeSourceFile(name: string, content = 'hello'): string {
  const file = join(dir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

describe('knowledge IPC handlers', () => {
  it('注册全部通道（配置 2 + 知识库本体 17 + 索引/检索/问答/图谱/社区/备份 9）', () => {
    const { ipc } = createHarness()
    for (const channel of [
      'knowledge:get-kb-settings',
      'knowledge:set-kb-settings',
      'knowledge:list-kbs',
      'knowledge:create-kb',
      'knowledge:update-kb',
      'knowledge:delete-kb',
      'knowledge:reorder-kbs',
      'knowledge:set-kb-pinned',
      'knowledge:stats',
      'knowledge:list-docs',
      'knowledge:import',
      'knowledge:rename-doc',
      'knowledge:remove-doc',
      'knowledge:read-file',
      'knowledge:read-image-bytes',
      'knowledge:open-dir',
      'knowledge:create-share',
      'knowledge:list-shares',
      'knowledge:revoke-share',
      'knowledge:reindex',
      'knowledge:retry-doc',
      'knowledge:cancel-index',
      'knowledge:reextract-graph',
      'knowledge:rebuild-communities',
      'knowledge:backup-index',
      'knowledge:search',
      'knowledge:ask',
      'knowledge:cancel-ask'
    ]) {
      expect(ipc.handle).toHaveBeenCalledWith(channel, expect.any(Function))
    }
    expect(ipc.handlers.size).toBe(28)
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

  it('import 索引方式非 none：落库为 queued 并入队（索引能力已开放）', async () => {
    const { ipc, indexService } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '索引测试库'
    })
    const result = await ipc.invoke<{ success: boolean; data?: { accepted: Array<{ status: string; id: string }> } }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('a.md'), relPath: 'a.md' }],
      'default'
    )
    expect(result.success).toBe(true)
    expect(result.data?.accepted[0].status).toBe('queued')
    expect(indexService.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      created.data.id,
      [result.data?.accepted[0].id]
    )
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

  it('打开文件夹：知识库目录与文件所在目录（路径由主进程解析）', async () => {
    const { ipc, openedDirs, revealedFiles } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '目录测试库'
    })
    const kbId = created.data.id
    await ipc.invoke('knowledge:import', kbId, [
      { srcPath: makeSourceFile('目录.md', '# 目录'), relPath: '资料/目录.md' }
    ])

    // 知识库目录：不传 relPath → openDir
    const base = await ipc.invoke<{ success: boolean }>('knowledge:open-dir', kbId)
    expect(base.success).toBe(true)
    expect(openedDirs[0]).toBe(join(dir, 'files', kbId))
    expect(existsSync(openedDirs[0])).toBe(true)

    // 文件：传 relPath → 在资源管理器中定位该文件
    const fileDir = await ipc.invoke<{ success: boolean }>('knowledge:open-dir', kbId, '资料/目录.md')
    expect(fileDir.success).toBe(true)
    expect(revealedFiles[0].endsWith('目录.md')).toBe(true)

    // 不存在的文件 → 明确报错
    const missing = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:open-dir',
      kbId,
      '不存在.md'
    )
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('文件不存在')

    // 未登录 → 拒绝
    const anonymous = createHarness(null)
    const denied = await anonymous.ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:open-dir',
      kbId
    )
    expect(denied.success).toBe(false)
    expect(denied.error).toContain('未登录')
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

    // 索引/检索通道同样要求登录
    for (const channel of ['knowledge:reindex', 'knowledge:cancel-index', 'knowledge:search', 'knowledge:retry-doc']) {
      const result = await ipc.invoke<{ success: boolean; error?: string }>(
        channel,
        'kb-1',
        'q'
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('未登录')
    }
  })

  it('import default：主进程按生效配置生成快照并落库、入队', async () => {
    const { ipc, indexService, knowledgeStore } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '默认索引库'
    })
    const result = await ipc.invoke<{
      success: boolean
      data: { accepted: Array<{ id: string; status: string }> }
    }>('knowledge:import', created.data.id, [
      { srcPath: makeSourceFile('d.md', '默认索引'), relPath: 'd.md' }
    ], 'default')
    expect(result.success).toBe(true)
    expect(result.data.accepted[0].status).toBe('queued')

    // 快照落库且包含 14 个索引项（不含上传项与端点）
    const doc = knowledgeStore.getDocumentById(result.data.accepted[0].id)
    const snapshot = JSON.parse(doc?.config ?? '{}') as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual(
      ['bm25B', 'bm25K1', 'chunkOverlap', 'chunkSize', 'chunkStrategy', 'embeddingModel', 'graphEnabled', 'graphModel', 'hybridWeight', 'rerankEnabled', 'rerankModel', 'sparseRetrieval', 'topK', 'vectorDimensions'].sort()
    )
    expect(snapshot).not.toHaveProperty('maxUploadSize')
    // 主进程负责入队
    expect(indexService.enqueue).toHaveBeenCalledWith('u1', created.data.id, [result.data.accepted[0].id])
  })

  it('import custom：校验渲染层快照，非法值直接拒绝', async () => {
    const { ipc } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '自定义索引库'
    })
    const bad = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('c.md', '自定义'), relPath: 'c.md' }],
      'custom',
      { chunkSize: 1 }
    )
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('非法')

    const missing = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('c2.md', '自定义2'), relPath: 'c2.md' }],
      'custom'
    )
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('缺少配置项')

    const good = await ipc.invoke<{ success: boolean; data: { accepted: Array<{ id: string }> } }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('c3.md', '自定义3'), relPath: 'c3.md' }],
      'custom',
      { chunkStrategy: 'fixed', chunkSize: 400 }
    )
    expect(good.success).toBe(true)
  })

  it('reindex / cancel-index / retry-doc：按文档集合驱动索引服务', async () => {
    const { ipc, indexService } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '重建库'
    })
    const imported = await ipc.invoke<{ data: { accepted: Array<{ id: string; relPath: string }> } }>(
      'knowledge:import',
      created.data.id,
      [{ srcPath: makeSourceFile('r.md', '重建'), relPath: 'r.md' }],
      'default'
    )
    const docId = imported.data.accepted[0].id

    const reindex = await ipc.invoke<{ success: boolean; data: { queued: number } }>(
      'knowledge:reindex',
      created.data.id,
      ['r.md']
    )
    expect(reindex.success).toBe(true)
    expect(indexService.enqueue).toHaveBeenCalledWith(
      'u1',
      created.data.id,
      [docId],
      { refreshConfig: true }
    )

    const cancel = await ipc.invoke<{ success: boolean }>('knowledge:cancel-index', created.data.id)
    expect(cancel.success).toBe(true)
    expect(indexService.cancel).toHaveBeenCalled()

    // 只有 failed 允许重试（刚导入是 queued）
    const retry = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:retry-doc',
      created.data.id,
      'r.md'
    )
    expect(retry.success).toBe(false)
    expect(retry.error).toContain('只有索引失败')
  })

  it('search：查到已写入的切片并返回引用信息；无数据显示空结果', async () => {
    const { ipc, knowledgeStore, sparseIndexer } = createHarness()
    const created = await ipc.invoke<{ data: { id: string } }>('knowledge:create-kb', {
      name: '检索库'
    })
    const kbId = created.data.id
    knowledgeStore.insertDocument({
      id: 'doc-search',
      kbId,
      userId: 'u1',
      name: '检索.md',
      type: 'MD',
      sizeBytes: 10,
      relPath: 'notes/检索.md',
      storagePath: join(dir, 'files', kbId, 'doc-search', '检索.md'),
      indexState: 'default',
      contentHash: null
    })
    const content = '知识库的混合检索由向量与关键词两路融合。'
    knowledgeStore.replaceDocumentIndex({
      docId: 'doc-search',
      kbId,
      userId: 'u1',
      chunks: [{ index: 0, content, tokenCount: 20, charStart: 0, charEnd: content.length }],
      tokens: [sparseIndexer.tokenize(content)],
      vectors: null,
      vectorDim: null,
      vectorModel: null
    })

    const hit = await ipc.invoke<{
      success: boolean
      data: { hits: Array<{ content: string; relPath: string; docName: string }> }
    }>('knowledge:search', kbId, '混合检索')
    expect(hit.success).toBe(true)
    expect(hit.data.hits.length).toBeGreaterThan(0)
    expect(hit.data.hits[0].relPath).toBe('notes/检索.md')
    expect(hit.data.hits[0].docName).toBe('检索.md')
    expect(hit.data.hits[0].content).toContain('混合检索')

    // 与正文无任何 token 交集的查询：覆盖率过滤后为空（不会拿常见字硬凑命中）
    const empty = await ipc.invoke<{
      success: boolean
      data: { hits: unknown[]; noRelevantResult: boolean }
    }>('knowledge:search', kbId, '股票行情')
    expect(empty.success).toBe(true)
    expect(empty.data.hits).toEqual([])
    expect(empty.data.noRelevantResult).toBe(true)

    const badMode = await ipc.invoke<{ success: boolean; error?: string }>(
      'knowledge:search',
      kbId,
      '混合',
      { mode: 'invalid' }
    )
    expect(badMode.success).toBe(false)
    expect(badMode.error).toContain('检索模式非法')
  })
})
