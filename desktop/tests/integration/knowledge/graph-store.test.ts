import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import { normalizeName } from '../../../src/main/knowledge/entity-norm'
import type { KnowledgeChunk } from '../../../src/main/knowledge/types'

/**
 * 图谱存储与一跳扩展（真实 SQLite）。
 * 前提：better-sqlite3 需切换到 Node ABI（见同目录 index-pipeline.test.ts 顶部说明）。
 */

let dir: string
let store: KnowledgeStore
let kbId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-graph-'))
  store = new KnowledgeStore(() => dir)
  kbId = store.createBase('u1', { name: '图谱库', description: '', kind: 'local' }).id
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** 造文档 + 切片，返回切片 id */
function seedDoc(docId: string, contents: string[]): number[] {
  store.insertDocument({
    id: docId,
    kbId,
    userId: 'u1',
    name: `${docId}.md`,
    type: 'MD',
    sizeBytes: 10,
    relPath: `${docId}.md`,
    storagePath: join(dir, 'files', kbId, docId, `${docId}.md`),
    indexState: 'default',
    contentHash: null
  })
  const chunks: KnowledgeChunk[] = contents.map((content, index) => ({
    index,
    content,
    tokenCount: content.length,
    charStart: index * 100,
    charEnd: index * 100 + content.length
  }))
  store.replaceDocumentIndex({
    docId,
    kbId,
    userId: 'u1',
    chunks,
    tokens: null,
    vectors: null,
    vectorDim: null,
    vectorModel: null
  })
  return store.listChunksForDoc(docId).map((chunk) => chunk.id)
}

function entity(
  name: string,
  type: string,
  chunkId: number | null
): {
  name: string
  nameKey: string
  type: string
  chunkId: number | null
  chunkIndex: number
  sourceText: string
  charStart: number
  charEnd: number
} {
  return {
    name,
    nameKey: normalizeName(name),
    type,
    chunkId,
    chunkIndex: 0,
    sourceText: name,
    charStart: 0,
    charEnd: name.length
  }
}

describe('图谱存储（按文档）', () => {
  it('写入后可聚合查询；同一实体跨文档分别成行、查询侧折叠计数', () => {
    const [chunkA] = seedDoc('doc-a', ['Transformer 架构由 Vaswani 提出。'])
    const [chunkB] = seedDoc('doc-b', ['BERT 基于 Transformer。'])

    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('Transformer', '产品', chunkA), entity('Vaswani', '人物', chunkA)],
      relations: [
        {
          fromEntity: 'Vaswani',
          toEntity: 'Transformer',
          fromKey: 'vaswani',
          toKey: 'transformer',
          label: '提出',
          chunkId: chunkA,
          description: null
        }
      ]
    })
    store.replaceDocumentGraph({
      docId: 'doc-b',
      kbId,
      userId: 'u1',
      entities: [entity('Transformer', '产品', chunkB), entity('BERT', '产品', chunkB)],
      relations: [
        {
          fromEntity: 'BERT',
          toEntity: 'Transformer',
          fromKey: 'bert',
          toKey: 'transformer',
          label: '基于',
          chunkId: chunkB,
          description: null
        }
      ]
    })

    const entities = store.listEntities(kbId)
    const transformer = entities.find((item) => item.nameKey === 'transformer')
    expect(transformer).toMatchObject({ type: '产品', mentions: 2 })
    expect(store.countGraphEntities(kbId)).toBe(4)
    expect(store.countDocumentGraph('doc-a')).toEqual({ entities: 2, relations: 1 })
  })

  it('重抽（先清后写）：旧行不残留，计数随之更新', () => {
    const [chunkA] = seedDoc('doc-a', ['内容一'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('旧实体', '概念', chunkA)],
      relations: []
    })
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('新实体', '概念', chunkA)],
      relations: []
    })
    expect(store.countDocumentGraph('doc-a')).toEqual({ entities: 1, relations: 0 })
    expect(store.listDocumentGraph('doc-a')[0].name).toBe('新实体')
  })

  it('删文档索引时图谱一并清理', () => {
    const [chunkA] = seedDoc('doc-a', ['内容'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('实体', '概念', chunkA)],
      relations: []
    })
    store.deleteDocumentIndex('doc-a')
    expect(store.countGraphEntities(kbId)).toBe(0)

    const [chunkB] = seedDoc('doc-b', ['内容'])
    store.replaceDocumentGraph({
      docId: 'doc-b',
      kbId,
      userId: 'u1',
      entities: [entity('实体', '概念', chunkB)],
      relations: []
    })
    store.deleteDocumentGraph('doc-b')
    expect(store.countGraphEntities(kbId)).toBe(0)
  })
})

describe('图谱一跳扩展（检索第三路）', () => {
  function seedTwoDocs(): { chunkA: number; chunkB: number } {
    const [chunkA] = seedDoc('doc-a', ['Transformer 架构由 Vaswani 提出，这是一个重要突破。'])
    const [chunkB] = seedDoc('doc-b', ['BERT 是基于 Transformer 的预训练模型。'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('Transformer', '产品', chunkA), entity('Vaswani', '人物', chunkA)],
      relations: [
        {
          fromEntity: 'Vaswani',
          toEntity: 'Transformer',
          fromKey: 'vaswani',
          toKey: 'transformer',
          label: '提出',
          chunkId: chunkA,
          description: null
        }
      ]
    })
    store.replaceDocumentGraph({
      docId: 'doc-b',
      kbId,
      userId: 'u1',
      entities: [entity('BERT', '产品', chunkB), entity('Transformer', '产品', chunkB)],
      relations: [
        {
          fromEntity: 'BERT',
          toEntity: 'Transformer',
          fromKey: 'bert',
          toKey: 'transformer',
          label: '基于',
          chunkId: chunkB,
          description: null
        }
      ]
    })
    return { chunkA, chunkB }
  }

  it('查询串命中种子实体 → 沿关系找到邻居 → 返回关联切片', () => {
    const { chunkA, chunkB } = seedTwoDocs()
    // 查询里含「Vaswani」→ 种子 = Vaswani；一跳邻居 = Transformer → 其切片含 doc-b 那块
    const expanded = store.graphExpand({ kbId, userId: 'u1', query: 'Vaswani 是谁', limit: 10 })
    expect(expanded.seedNames).toContain('Vaswani')
    expect(expanded.chunkIds).toEqual(expect.arrayContaining([chunkA, chunkB]))
  })

  it('查询里没有实体：不扩展（不返回噪声）', () => {
    const [chunkA] = seedDoc('doc-a', ['Transformer 架构。'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('Transformer', '产品', chunkA)],
      relations: []
    })
    const expanded = store.graphExpand({ kbId, userId: 'u1', query: '今天天气怎么样', limit: 10 })
    expect(expanded.chunkIds).toEqual([])
    expect(expanded.seedNames).toEqual([])
  })

  it('单字实体不作为种子（避免「的」这类误命中）', () => {
    const [chunkA] = seedDoc('doc-a', ['内容'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('的', '概念', chunkA)],
      relations: []
    })
    const expanded = store.graphExpand({ kbId, userId: 'u1', query: '这是我的东西', limit: 10 })
    expect(expanded.seedNames).toEqual([])
  })

  it('用户隔离：别人的实体查不到', () => {
    const [chunkA] = seedDoc('doc-a', ['Transformer 架构。'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('Transformer', '产品', chunkA)],
      relations: []
    })
    expect(
      store.graphExpand({ kbId, userId: 'u2', query: 'Transformer', limit: 10 }).chunkIds
    ).toEqual([])
  })
})

describe('索引库备份（VACUUM INTO）', () => {
  it('备份副本可独立打开且数据完整；目标已存在时报错', () => {
    const [chunkA] = seedDoc('doc-a', ['备份验证 内容'])
    store.replaceDocumentGraph({
      docId: 'doc-a',
      kbId,
      userId: 'u1',
      entities: [entity('实体甲', '概念', chunkA)],
      relations: []
    })
    const dest = join(dir, 'backup', `index-${Date.now()}.db`)
    mkdirSync(join(dir, 'backup'), { recursive: true })

    const result = store.backupTo(dest)
    expect(result.sizeBytes).toBeGreaterThan(0)

    // 副本可独立打开，切片/实体/文档行数与原库一致（改名成 index.db 才能被 store 打开）
    renameSync(dest, join(dir, 'backup', 'index.db'))
    const copyStore = new KnowledgeStore(() => join(dir, 'backup'))
    expect(copyStore.countChunks(kbId)).toBe(store.countChunks(kbId))
    expect(copyStore.countGraphEntities(kbId)).toBe(1)
    expect(copyStore.listDocuments('u1', kbId)).toHaveLength(1)
    copyStore.close()

    // 目标文件已存在：明确报错（SQLite 的 VACUUM INTO 要求目标不存在）
    expect(() => store.backupTo(join(dir, 'backup', 'index.db'))).toThrow('目标文件已存在')
  })
})
