import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KnowledgeSettingsStore } from '../../../src/main/knowledge/KnowledgeSettingsStore'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function filePath(): string {
  return join(dir, 'kb-settings.json')
}

function readFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath(), 'utf-8')) as Record<string, unknown>
}

describe('KnowledgeSettingsStore', () => {
  it('空目录：读到空映射且不生成文件（首次写入才落盘）', () => {
    const store = new KnowledgeSettingsStore(dir)
    expect(store.getUserKbMap('u1')).toEqual({})
    expect(existsSync(filePath())).toBe(false)
  })

  it('写后落盘结构为 { version, users }，且保持稀疏', () => {
    const store = new KnowledgeSettingsStore(dir)
    store.setUserKbMap('u1', { product: { chunkSize: 1200, rerankEnabled: false } })
    const raw = readFile()
    expect(raw['version']).toBe(1)
    expect(raw['users']).toEqual({
      u1: { product: { chunkSize: 1200, rerankEnabled: false } }
    })
    // 未覆盖的项与未配置的知识库都不得出现
    const users = raw['users'] as Record<string, { product: Record<string, unknown> }>
    expect(Object.keys(users.u1.product)).toEqual(['chunkSize', 'rerankEnabled'])
  })

  it('空覆盖项不落盘（省略即跟随全局）', () => {
    const store = new KnowledgeSettingsStore(dir)
    store.setUserKbMap('u1', { product: {} })
    // 落盘（与 SettingsStore.set 一致），但不得产生任何条目
    expect(readFile()['users']).toEqual({})
    expect(store.getUserKbMap('u1')).toEqual({})
  })

  it('清空某用户后不残留空节点', () => {
    const store = new KnowledgeSettingsStore(dir)
    store.setUserKbMap('u1', { product: { chunkSize: 1200 } })
    store.setUserKbMap('u1', {})
    expect(readFile()['users']).toEqual({})
    expect(existsSync(filePath())).toBe(true) // 已经写过盘
  })

  it('新建实例仍读得到（重启仍在）', () => {
    const first = new KnowledgeSettingsStore(dir)
    first.setUserKbMap('u1', { product: { chunkSize: 1200 } })
    const second = new KnowledgeSettingsStore(dir)
    expect(second.getUserKbMap('u1')).toEqual({ product: { chunkSize: 1200 } })
  })

  it('多用户隔离，互不影响', () => {
    const store = new KnowledgeSettingsStore(dir)
    store.setUserKbMap('u1', { product: { chunkSize: 1200 } })
    store.setUserKbMap('u2', { product: { chunkSize: 400 } })
    expect(store.getUserKbMap('u1')).toEqual({ product: { chunkSize: 1200 } })
    expect(store.getUserKbMap('u2')).toEqual({ product: { chunkSize: 400 } })
  })

  it('getUserKbMap 返回浅拷贝，外部改动不污染内部快照', () => {
    const store = new KnowledgeSettingsStore(dir)
    store.setUserKbMap('u1', { product: { chunkSize: 1200 } })
    const view = store.getUserKbMap('u1')
    view.product.chunkSize = 999
    view.extra = { topK: 3 }
    expect(store.getUserKbMap('u1')).toEqual({ product: { chunkSize: 1200 } })
  })

  it('损坏文件且无 .bak：保留 .corrupt 并回退空', () => {
    writeFileSync(filePath(), '{corrupted!!!', 'utf-8')
    const store = new KnowledgeSettingsStore(dir)
    expect(store.getUserKbMap('u1')).toEqual({})
    expect(existsSync(`${filePath()}.corrupt`)).toBe(true)
    expect(existsSync(filePath())).toBe(false)
  })

  it('损坏文件但有 .bak：从 .bak 恢复且不覆盖 .bak', () => {
    const first = new KnowledgeSettingsStore(dir)
    first.setUserKbMap('u1', { product: { chunkSize: 1200 } })
    first.setUserKbMap('u1', { product: { chunkSize: 1500 } }) // 第二次写入 → .bak 为第一版
    writeFileSync(filePath(), '{corrupted!!!', 'utf-8')

    const restored = new KnowledgeSettingsStore(dir)
    expect(restored.getUserKbMap('u1')).toEqual({ product: { chunkSize: 1200 } })
    expect(existsSync(`${filePath()}.corrupt`)).toBe(false)
    // 恢复后正式文件已修复，且 .bak 仍是好备份
    expect(restored.getUserKbMap('u1').product.chunkSize).toBe(1200)
    const bak = JSON.parse(readFileSync(`${filePath()}.bak`, 'utf-8')) as Record<string, unknown>
    expect(bak['users']).not.toBeUndefined()
  })

  it('高版本文件：忽略内容且不破坏原文件', () => {
    writeFileSync(
      filePath(),
      JSON.stringify({ version: 2, users: { u1: { product: { chunkSize: 1200 } } } }),
      'utf-8'
    )
    const store = new KnowledgeSettingsStore(dir)
    expect(store.getUserKbMap('u1')).toEqual({})
    expect(readFile()['version']).toBe(2) // 未写盘覆盖
  })

  it('磁盘上的非法项被静默丢弃', () => {
    // 用原始文本写入：对象字面量里的 __proto__ 会改写原型而不是成为自有键
    const content = `{
      "version": 1,
      "users": {
        "u1": {
          "product": { "chunkSize": 99999, "chunkStrategy": "bogus", "topK": 5, "bogus": 1 },
          "__proto__": { "chunkSize": 800 }
        }
      }
    }`
    writeFileSync(filePath(), content, 'utf-8')
    const store = new KnowledgeSettingsStore(dir)
    expect(store.getUserKbMap('u1')).toEqual({ product: { topK: 5 } })
    expect(({} as Record<string, unknown>).chunkSize).toBeUndefined()
  })

  it('非法用户 id / 知识库 id 在写入路径抛错', () => {
    const store = new KnowledgeSettingsStore(dir)
    expect(() => store.setUserKbMap('', { product: { topK: 3 } })).toThrow(/不能为空/)
    expect(() => store.setUserKbMap('__proto__', { product: { topK: 3 } })).toThrow(/非法/)
    expect(() => store.setUserKbMap('u1', { '': { topK: 3 } })).toThrow(/不能为空/)
    expect(() => store.getUserKbMap('constructor')).toThrow(/非法/)
  })
})
