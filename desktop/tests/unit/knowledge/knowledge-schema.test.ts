import { describe, expect, it } from 'vitest'
import { isSettingsKey, SETTINGS_SCHEMA, type SettingsKey } from '../../../src/main/settings/schema'
import {
  assertKbId,
  assertKbIdList,
  assertKnowledgeOverrides,
  KNOWLEDGE_OVERRIDE_KEYS,
  normalizeKnowledgeOverrides,
  toSettingsKey
} from '../../../src/main/knowledge/knowledge-schema'

/** schema 中全部 knowledge.* key（可覆盖项 = 其减去 directory） */
const ALL_KNOWLEDGE_KEYS = (Object.keys(SETTINGS_SCHEMA) as SettingsKey[]).filter((key) =>
  key.startsWith('knowledge.')
)

describe('knowledge-schema 可覆盖项清单', () => {
  it('派生 17 项且不含存放目录', () => {
    expect(KNOWLEDGE_OVERRIDE_KEYS).toHaveLength(17)
    expect(KNOWLEDGE_OVERRIDE_KEYS).not.toContain('directory')
  })

  it('与 SETTINGS_SCHEMA 的 knowledge.* 逐项对齐（防漂移）', () => {
    const expected = ALL_KNOWLEDGE_KEYS.filter((key) => key !== 'knowledge.directory').map((key) =>
      key.slice('knowledge.'.length)
    )
    expect([...KNOWLEDGE_OVERRIDE_KEYS]).toEqual(expected)
  })

  it('每个短 key 拼回后都是合法设置 key', () => {
    for (const key of KNOWLEDGE_OVERRIDE_KEYS) {
      expect(isSettingsKey(toSettingsKey(key))).toBe(true)
    }
  })
})

describe('assertKnowledgeOverrides 严格校验', () => {
  it('接受合法值并保留假值（0 / false 也是有效覆盖）', () => {
    const input = {
      bm25B: 0,
      graphEnabled: false,
      topK: 1,
      sparseRetrieval: false,
      chunkSize: 1200,
      chunkStrategy: 'fixed'
    }
    expect(assertKnowledgeOverrides(input)).toEqual(input)
  })

  it('保留边界值', () => {
    expect(assertKnowledgeOverrides({ bm25K1: 0, hybridWeight: 1, chunkOverlap: 0 })).toEqual({
      bm25K1: 0,
      hybridWeight: 1,
      chunkOverlap: 0
    })
  })

  it('拒绝越界数值', () => {
    expect(() => assertKnowledgeOverrides({ chunkSize: 99999 })).toThrow(/chunkSize/)
    expect(() => assertKnowledgeOverrides({ maxUploadSize: 0 })).toThrow(/maxUploadSize/)
  })

  it('拒绝非法枚举与非法向量维度', () => {
    expect(() => assertKnowledgeOverrides({ chunkStrategy: 'bogus' })).toThrow(/chunkStrategy/)
    expect(() => assertKnowledgeOverrides({ vectorDimensions: 2048 })).toThrow(/vectorDimensions/)
  })

  it('拒绝空字符串模型名', () => {
    expect(() => assertKnowledgeOverrides({ embeddingModel: '  ' })).toThrow(/embeddingModel/)
  })

  it('拒绝未知 key（含存放目录与原型污染键）', () => {
    expect(() => assertKnowledgeOverrides({ directory: '/tmp' })).toThrow(/未知的知识库配置项/)
    expect(() => assertKnowledgeOverrides({ bogus: 1 })).toThrow(/未知的知识库配置项/)
    expect(() => assertKnowledgeOverrides(JSON.parse('{"__proto__":1}'))).toThrow(
      /未知的知识库配置项/
    )
  })

  it('拒绝非对象入参', () => {
    expect(() => assertKnowledgeOverrides(null)).toThrow(/必须为对象/)
    expect(() => assertKnowledgeOverrides('x')).toThrow(/必须为对象/)
    expect(() => assertKnowledgeOverrides([1])).toThrow(/必须为对象/)
  })

  it('输出为稀疏结构：未提供的 key 不出现', () => {
    const out = assertKnowledgeOverrides({ chunkSize: 1200 })
    expect(Object.keys(out)).toEqual(['chunkSize'])
  })
})

describe('normalizeKnowledgeOverrides 宽松读取', () => {
  it('静默丢弃非法项，保留合法项', () => {
    const out = normalizeKnowledgeOverrides({
      chunkSize: 1200,
      chunkStrategy: 'bogus',
      bogus: 1,
      topK: '12'
    })
    expect(out).toEqual({ chunkSize: 1200 })
  })

  it('非对象入参返回空对象', () => {
    expect(normalizeKnowledgeOverrides(null)).toEqual({})
    expect(normalizeKnowledgeOverrides('x')).toEqual({})
    expect(normalizeKnowledgeOverrides([1])).toEqual({})
    expect(normalizeKnowledgeOverrides(undefined)).toEqual({})
  })

  it('不会被 __proto__ 键污染原型', () => {
    const out = normalizeKnowledgeOverrides(JSON.parse('{"__proto__":{"polluted":true}}'))
    expect(Object.keys(out)).toHaveLength(0)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('assertKbId 知识库 ID 守卫', () => {
  it('接受普通 id 并去首尾空格', () => {
    expect(assertKbId('product')).toBe('product')
    expect(assertKbId('  design  ')).toBe('design')
  })

  it('拒绝非字符串 / 空串 / 超长', () => {
    expect(() => assertKbId(123)).toThrow(/必须为字符串/)
    expect(() => assertKbId('')).toThrow(/不能为空/)
    expect(() => assertKbId('   ')).toThrow(/不能为空/)
    expect(() => assertKbId('a'.repeat(129))).toThrow(/过长/)
  })

  it('拒绝原型污染键', () => {
    expect(() => assertKbId('__proto__')).toThrow(/非法/)
    expect(() => assertKbId('constructor')).toThrow(/非法/)
    expect(() => assertKbId('prototype')).toThrow(/非法/)
  })
})

describe('assertKbIdList 列表守卫', () => {
  it('逐项校验并保持顺序', () => {
    expect(assertKbIdList(['product', ' design '])).toEqual(['product', 'design'])
    expect(assertKbIdList([])).toEqual([])
  })

  it('拒绝非数组 / 数量过多 / 含非法元素', () => {
    expect(() => assertKbIdList('product')).toThrow(/必须为数组/)
    expect(() => assertKbIdList(new Array(201).fill('a'))).toThrow(/数量过多/)
    expect(() => assertKbIdList(['product', 2])).toThrow(/必须为字符串/)
  })
})
