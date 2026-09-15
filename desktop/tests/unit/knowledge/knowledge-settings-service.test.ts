import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KnowledgeSettingsService } from '../../../src/main/knowledge/KnowledgeSettingsService'
import { KnowledgeSettingsStore } from '../../../src/main/knowledge/KnowledgeSettingsStore'
import { KNOWLEDGE_OVERRIDE_KEYS } from '../../../src/main/knowledge/knowledge-schema'
import { defaultSettings } from '../../../src/main/settings/schema'

let dir: string
/** 可变的全局设置快照（模拟 SettingsStore.getAll()） */
let globalSettings: Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ke-kb-service-'))
  globalSettings = defaultSettings()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function createService(): KnowledgeSettingsService {
  const store = new KnowledgeSettingsStore(dir)
  return new KnowledgeSettingsService(store, { getGlobalSettings: () => globalSettings })
}

describe('KnowledgeSettingsService', () => {
  it('未覆盖项跟随全局，覆盖项取覆盖值', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { chunkSize: 1200 })
    const { effective, overridden } = service.getEffective('u1', 'product')
    expect(effective.chunkSize).toBe(1200)
    expect(effective.topK).toBe(12) // 全局默认
    expect(effective.chunkStrategy).toBe('semantic') // 全局默认
    expect(overridden).toEqual(['chunkSize'])
  })

  it('生效配置覆盖全部 17 项', () => {
    const service = createService()
    const { effective } = service.getEffective('u1', 'product')
    expect(Object.keys(effective).sort()).toEqual([...KNOWLEDGE_OVERRIDE_KEYS].sort())
    expect(Object.keys(effective)).toHaveLength(17)
  })

  it('改全局后：未覆盖项立即变，覆盖项不变', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { chunkSize: 1200 })

    globalSettings['knowledge.chunkSize'] = 400
    globalSettings['knowledge.topK'] = 30

    const { effective } = service.getEffective('u1', 'product')
    expect(effective.chunkSize).toBe(1200) // 覆盖项不受全局影响
    expect(effective.topK).toBe(30) // 未覆盖项跟随全局
  })

  it('假值覆盖有效（0 / false / 1 不会被全局值吃掉）', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { bm25B: 0, rerankEnabled: false, topK: 1 })
    const { effective, overridden } = service.getEffective('u1', 'product')
    expect(effective.bm25B).toBe(0) // 全局默认 0.75
    expect(effective.rerankEnabled).toBe(false) // 全局默认 true
    expect(effective.topK).toBe(1) // 全局默认 12
    expect(overridden).toHaveLength(3)
  })

  it('非法值/未知 key 抛错且不落盘', () => {
    const service = createService()
    expect(() => service.setOverrides('u1', 'product', { chunkSize: 99999 })).toThrow(/chunkSize/)
    expect(() => service.setOverrides('u1', 'product', { chunkStrategy: 'bogus' })).toThrow(
      /chunkStrategy/
    )
    expect(() => service.setOverrides('u1', 'product', { directory: '/tmp' })).toThrow(
      /未知的知识库配置项/
    )
    expect(service.getOverrides('u1', 'product')).toEqual({})
    expect(existsSync(join(dir, 'kb-settings.json'))).toBe(false)
  })

  it('传 {} 即恢复全部跟随全局（条目被清除）', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { chunkSize: 1200 })
    expect(service.setOverrides('u1', 'product', {})).toEqual({})
    expect(service.getOverrides('u1', 'product')).toEqual({})
    expect(service.getOverridesBatch('u1')).toEqual({})
    expect(service.getEffective('u1', 'product').effective.chunkSize).toBe(800) // 回到全局默认
  })

  it('用户之间互相隔离', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { chunkSize: 1200 })
    service.setOverrides('u2', 'product', { chunkSize: 400 })
    expect(service.getEffective('u1', 'product').effective.chunkSize).toBe(1200)
    expect(service.getEffective('u2', 'product').effective.chunkSize).toBe(400)
    expect(service.getOverrides('u3', 'product')).toEqual({})
  })

  it('批量读取：指定 kbIds 时未配置项返回空对象，省略时只返回已配置项', () => {
    const service = createService()
    service.setOverrides('u1', 'product', { chunkSize: 1200 })
    expect(service.getOverridesBatch('u1', ['product', 'design'])).toEqual({
      product: { chunkSize: 1200 },
      design: {}
    })
    expect(service.getOverridesBatch('u1')).toEqual({ product: { chunkSize: 1200 } })
  })

  it('知识库 id 非法时抛错（含原型污染键）', () => {
    const service = createService()
    expect(() => service.getOverrides('u1', '')).toThrow(/不能为空/)
    expect(() => service.setOverrides('u1', '__proto__', { topK: 3 })).toThrow(/非法/)
    expect(() => service.getOverridesBatch('u1', ['__proto__'])).toThrow(/非法/)
  })

  it('重启后覆盖项仍在（跨实例）', () => {
    createService().setOverrides('u1', 'product', { chunkSize: 1200 })
    expect(createService().getOverrides('u1', 'product')).toEqual({ chunkSize: 1200 })
  })
})
