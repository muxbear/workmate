import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { KnowledgeFileService } from '../../../src/main/knowledge/KnowledgeFileService'

let dir: string
let store: KnowledgeStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-store-'))
  store = new KnowledgeStore(() => dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('KnowledgeStore', () => {
  it('迁移幂等：重复打开不报错，且索引库落在 knowledge 目录下', () => {
    const kb = store.createBase('u1', { name: '库 A', description: '', kind: 'local' })
    expect(kb.id).toBeTruthy()
    store.close()
    const again = new KnowledgeStore(() => dir)
    expect(again.listBases('u1')).toHaveLength(1)
    expect(again.getDbPath()).toBe(join(dir, 'index.db'))
    again.close()
  })

  it('知识库 CRUD 与重名约束（仓储层不校验，服务层校验）', () => {
    const a = store.createBase('u1', { name: '库 A', description: 'd', kind: 'local' })
    store.createBase('u1', { name: '库 B', description: '', kind: 'cloud' })
    expect(store.listBases('u1')).toHaveLength(2)
    expect(store.listBases('u1', { kind: 'cloud' })).toHaveLength(1)
    expect(store.listBases('u1', { keyword: '库 B' })).toHaveLength(1)

    store.updateBase('u1', a.id, { name: '库 A2', description: '更新' })
    const updated = store.getBase('u1', a.id)
    expect(updated?.name).toBe('库 A2')
    expect(updated?.description).toBe('更新')

    expect(store.findBaseByName('u1', '库 A2')?.id).toBe(a.id)
    expect(store.deleteBase('u1', a.id)).toBe(1)
    expect(store.getBase('u1', a.id)).toBeNull()
  })

  it('用户隔离：看不到别人的知识库', () => {
    const mine = store.createBase('u1', { name: '我的库', description: '', kind: 'local' })
    store.createBase('u2', { name: '别人的库', description: '', kind: 'local' })
    expect(store.listBases('u1').map((row) => row.id)).toEqual([mine.id])
    expect(store.getBase('u2', mine.id)).toBeNull()
    expect(store.deleteBase('u2', mine.id)).toBe(0)
  })

  it('文档：插入 / 按前缀查询 / 改路径 / 删除 / 统计', () => {
    const kb = store.createBase('u1', { name: '库', description: '', kind: 'local' })
    const doc = store.insertDocument({
      id: 'doc-1',
      kbId: kb.id,
      userId: 'u1',
      name: '需求.md',
      type: 'MD',
      sizeBytes: 10,
      relPath: '设计/需求.md',
      storagePath: join(dir, 'files', kb.id, 'doc-1', '需求.md'),
      indexState: 'none',
      contentHash: 'hash-1'
    })
    expect(doc.status).toBe('none')

    expect(store.findDocument('u1', kb.id, '设计/需求.md')?.id).toBe('doc-1')
    expect(store.listDocumentsByPrefix('u1', kb.id, '设计')).toHaveLength(1)
    expect(store.listDocumentsByPrefix('u1', kb.id, '')).toHaveLength(1)
    expect(store.findDocumentByHash(kb.id, 'hash-1')?.id).toBe('doc-1')
    expect(store.findDocumentByHash(kb.id, 'hash-1', 'doc-1')).toBeNull()

    store.updateDocumentPath('doc-1', { name: '需求-终稿.md', relPath: '设计/需求-终稿.md' })
    expect(store.findDocument('u1', kb.id, '设计/需求-终稿.md')?.name).toBe('需求-终稿.md')

    store.refreshBaseStats(kb.id)
    expect(store.getBase('u1', kb.id)?.docsCount).toBe(1)
    expect(store.getBase('u1', kb.id)?.sizeBytes).toBe(10)

    expect(store.stats('u1')).toMatchObject({ kbCount: 1, docCount: 1, sizeBytes: 10 })

    store.deleteDocuments(['doc-1'])
    expect(store.listDocuments('u1', kb.id)).toEqual([])
  })

  it('共享：创建 / 列表 / 撤销 / 按目标清理', () => {
    const kb = store.createBase('u1', { name: '库', description: '', kind: 'local' })
    const share = store.insertShare({
      userId: 'u1',
      targetKind: 'library',
      targetId: kb.id,
      targetName: kb.name,
      permission: 'view',
      expiresAt: null
    })
    expect(share.url).toBe(`ke-work://share/${share.token}`)
    expect(store.listShares('u1')).toHaveLength(1)
    expect(store.revokeShare('u2', share.token)).toBe(0)
    expect(store.revokeShare('u1', share.token)).toBe(1)
    expect(store.listShares('u1')).toEqual([])

    store.insertShare({
      userId: 'u1',
      targetKind: 'library',
      targetId: kb.id,
      targetName: kb.name,
      permission: 'view',
      expiresAt: null
    })
    store.deleteSharesForTarget('u1', kb.id)
    expect(store.listShares('u1')).toEqual([])
  })

  it('目录变化后自动换库（旧库不迁移）', () => {
    let current = dir
    const switcher = new KnowledgeStore(() => current)
    switcher.createBase('u1', { name: '旧目录库', description: '', kind: 'local' })
    expect(switcher.listBases('u1')).toHaveLength(1)

    const next = mkdtempSync(join(tmpdir(), 'ke-kb-store-next-'))
    current = next
    expect(switcher.listBases('u1')).toHaveLength(0)
    switcher.close()
    rmSync(next, { recursive: true, force: true })
  })

  it('KnowledgeFileService 复用同一 store 的路径工具（规范化与名称校验）', () => {
    const files = new KnowledgeFileService(store, {
      getDir: () => dir,
      getLimits: () => ({ maxUploadSizeMB: 1, maxFilesPerBatch: 10, uploadTimeoutMinutes: 1 })
    })
    expect(files.normalizeRelPath('设计\\组件/按钮.md')).toBe('设计/组件/按钮.md')
    expect(() => files.normalizeRelPath('../a.md')).toThrow()
    expect(() => files.normalizeRelPath('/abs/a.md')).toThrow()
    expect(() => files.normalizeRelPath('')).toThrow()
    expect(files.sanitizeName('  按钮  ')).toBe('按钮')
    expect(() => files.sanitizeName('a/b')).toThrow()
    expect(() => files.sanitizeName('x'.repeat(61))).toThrow()
  })
})
