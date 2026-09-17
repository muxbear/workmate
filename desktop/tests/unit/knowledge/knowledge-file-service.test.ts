import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import {
  KnowledgeFileService,
  type KnowledgeUploadLimits
} from '../../../src/main/knowledge/KnowledgeFileService'

let dir: string
let store: KnowledgeStore
let files: KnowledgeFileService
let limits: KnowledgeUploadLimits
let kbId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-files-'))
  store = new KnowledgeStore(() => dir)
  limits = { maxUploadSizeMB: 1, maxFilesPerBatch: 3, uploadTimeoutMinutes: 10 }
  files = new KnowledgeFileService(store, { getDir: () => dir, getLimits: () => limits })
  kbId = store.createBase('u1', { name: '资料库', description: '', kind: 'local' }).id
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个真实源文件（默认 1KB 以内） */
function src(name: string, content = 'hello world'): string {
  const sourceDir = join(dir, 'src')
  mkdirSync(sourceDir, { recursive: true })
  const file = join(sourceDir, name)
  writeFileSync(file, content, 'utf-8')
  return file
}

describe('KnowledgeFileService', () => {
  it('导入：落盘到 files/<kbId>/<docId>/ 并把 relPath 记入索引库', () => {
    const file = src('需求说明.md', '# 需求\n- A')
    const result = files.importDocuments('u1', kbId, [
      { srcPath: file, relPath: '文档/需求说明.md' }
    ])
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0].relPath).toBe('文档/需求说明.md')
    expect(result.accepted[0].indexState).toBe('none')

    const docs = store.listDocuments('u1', kbId)
    expect(docs).toHaveLength(1)
    expect(existsSync(docs[0].storagePath)).toBe(true)
    expect(docs[0].storagePath.startsWith(join(dir, 'files', kbId))).toBe(true)
    expect(store.getBase('u1', kbId)?.docsCount).toBe(1)
  })

  it('导入：内容重复跳过（同库 sha256 去重）', () => {
    const a = src('a.md', 'same-content')
    const b = src('b.md', 'same-content')
    const result = files.importDocuments('u1', kbId, [
      { srcPath: a, relPath: 'a.md' },
      { srcPath: b, relPath: 'b.md' }
    ])
    expect(result.accepted).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('重复')
  })

  it('导入：同名文件被拒绝', () => {
    const a = src('a.md', 'aaa')
    const b = src('b.md', 'bbb')
    files.importDocuments('u1', kbId, [{ srcPath: a, relPath: '文档/a.md' }])
    const result = files.importDocuments('u1', kbId, [{ srcPath: b, relPath: '文档/a.md' }])
    expect(result.failed[0].reason).toContain('同名文件已存在')
  })

  it('导入：超过单文件上限 → failed；超过批次上限 → skipped', () => {
    const big = src('big.bin', 'x'.repeat(1024 * 1024 + 10))
    const tooBig = files.importDocuments('u1', kbId, [{ srcPath: big, relPath: 'big.bin' }])
    expect(tooBig.failed[0].reason).toContain('超过单文件上限')
    expect(store.listDocuments('u1', kbId)).toHaveLength(0)

    // 内容各不相同，避免被内容去重规则提前跳过（这里只验证批次上限）
    const many = [1, 2, 3, 4].map((n) => ({
      srcPath: src(`s${n}.md`, `content-${n}`),
      relPath: `f${n}.md`
    }))
    const overflow = files.importDocuments('u1', kbId, many)
    expect(overflow.skipped).toHaveLength(1)
    expect(overflow.skipped[0].reason).toContain('超出单批次上限')
  })

  it('导入：源文件不存在 / 路径越界 / 索引方式未开放', () => {
    const missing = files.importDocuments('u1', kbId, [
      { srcPath: join(dir, 'src', 'nope.md'), relPath: 'nope.md' }
    ])
    expect(missing.failed[0].reason).toContain('源文件不存在')

    const escape = files.importDocuments('u1', kbId, [
      { srcPath: src('c.md'), relPath: '../escape.md' }
    ])
    expect(escape.failed[0].reason).toContain('非法')

    expect(() =>
      files.importDocuments('u1', kbId, [{ srcPath: src('d.md'), relPath: 'd.md' }], 'custom')
    ).toThrow('索引功能尚未开放')
  })

  it('重命名：文件改 relPath；文件夹按前缀批量改写；重名报错', () => {
    files.importDocuments('u1', kbId, [
      { srcPath: src('a.md', 'a'), relPath: '设计/组件/a.md' },
      { srcPath: src('b.md', 'b'), relPath: '设计/组件/b.md' }
    ])

    const renamedFile = files.renameDocument('u1', kbId, '设计/组件/a.md', 'a-终稿.md')
    expect(renamedFile.relPath).toBe('设计/组件/a-终稿.md')
    expect(store.findDocument('u1', kbId, '设计/组件/a-终稿.md')?.name).toBe('a-终稿.md')

    const renamedFolder = files.renameDocument('u1', kbId, '设计/组件', '组件库')
    expect(renamedFolder.renamed).toBe(2)
    expect(renamedFolder.relPath).toBe('设计/组件库')
    expect(store.listDocumentsByPrefix('u1', kbId, '设计/组件库')).toHaveLength(2)

    expect(() => files.renameDocument('u1', kbId, '设计/组件库/a-终稿.md', 'b.md')).toThrow()
  })

  it('删除：文件夹递归删除文档与磁盘目录', () => {
    files.importDocuments('u1', kbId, [
      { srcPath: src('a.md', 'a'), relPath: '资料/a.md' },
      { srcPath: src('b.md', 'b'), relPath: '资料/b.md' }
    ])
    const before = store.listDocuments('u1', kbId)
    const removed = files.removeDocuments('u1', kbId, '资料')
    expect(removed.removed).toBe(2)
    expect(store.listDocuments('u1', kbId)).toEqual([])
    expect(store.getBase('u1', kbId)?.docsCount).toBe(0)
    for (const doc of before) {
      expect(existsSync(doc.storagePath)).toBe(false)
    }
  })

  it('读取：text 返回内容、bytes 返回字节；文件不存在时报错', async () => {
    files.importDocuments('u1', kbId, [
      { srcPath: src('note.md', '# 标题\n正文'), relPath: 'note.md' }
    ])
    const text = await files.readDocument('u1', kbId, 'note.md', 'text')
    expect(text.content).toContain('标题')
    expect(text.ext).toBe('md')

    const bytes = await files.readDocument('u1', kbId, 'note.md', 'bytes')
    expect(bytes.bytes?.length).toBeGreaterThan(0)
    expect(readFileSync(store.listDocuments('u1', kbId)[0].storagePath, 'utf-8')).toContain('标题')

    await expect(files.readDocument('u1', kbId, 'missing.md', 'text')).rejects.toThrow('文件不存在')
  })

  it('打开文件夹：解析知识库目录与文件位置，并拦截非法输入', () => {
    const base = files.resolveBaseDir('u1', kbId)
    expect(base).toBe(join(dir, 'files', kbId))
    expect(existsSync(base)).toBe(true)
    expect(() => files.resolveBaseDir('u1', 'not-exist')).toThrow('知识库不存在')

    files.importDocuments('u1', kbId, [{ srcPath: src('x.md', 'x'), relPath: '子目录/x.md' }])
    const location = files.resolveDocumentLocation('u1', kbId, '子目录/x.md')
    expect(location.file.endsWith('x.md')).toBe(true)
    expect(location.dir).toBe(dirname(location.file))
    expect(existsSync(location.file)).toBe(true)

    expect(() => files.resolveDocumentLocation('u1', kbId, '../x.md')).toThrow()
    expect(() => files.resolveDocumentLocation('u1', kbId, '不存在.md')).toThrow('文件不存在')
  })

  it('删库：清理全部文档与知识库目录', () => {
    files.importDocuments('u1', kbId, [
      { srcPath: src('a.md', 'a'), relPath: '子目录/a.md' }
    ])
    const removed = files.removeKnowledgeBaseFiles('u1', kbId)
    expect(removed).toBe(1)
    expect(store.listDocuments('u1', kbId)).toEqual([])
    expect(existsSync(join(dir, 'files', kbId))).toBe(false)
  })
})
