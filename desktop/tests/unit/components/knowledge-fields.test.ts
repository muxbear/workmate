import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createDraft,
  draftValueToOverride,
  KNOWLEDGE_FIELD_DEFS,
  KNOWLEDGE_FIELD_LIST,
  KNOWLEDGE_OVERRIDE_KEYS,
  parseNumber
} from '../../../src/renderer/src/components/knowledge/knowledgeFields'
import { useSettingsStore } from '../../../src/renderer/src/store/settings'
import { SETTINGS_SCHEMA, type SettingsKey } from '../../../src/main/settings/schema'
import { defaultSettings } from '../../../src/main/settings/schema'

const ALL_KNOWLEDGE_KEYS = (Object.keys(SETTINGS_SCHEMA) as SettingsKey[]).filter((key) =>
  key.startsWith('knowledge.')
)

describe('knowledgeFields 字段表', () => {
  it('17 项且不含存放目录', () => {
    expect(KNOWLEDGE_OVERRIDE_KEYS).toHaveLength(17)
    expect(KNOWLEDGE_OVERRIDE_KEYS).not.toContain('directory')
  })

  it('与主进程 schema 的 knowledge.* 完全对齐（防漂移）', () => {
    const expected = ALL_KNOWLEDGE_KEYS.filter((key) => key !== 'knowledge.directory').map((key) =>
      key.slice('knowledge.'.length)
    )
    expect([...KNOWLEDGE_OVERRIDE_KEYS].sort()).toEqual(expected.sort())
  })

  it('每项都有 label，数值项都有区间', () => {
    for (const field of KNOWLEDGE_FIELD_LIST) {
      expect(field.label).toBeTruthy()
      if (field.kind === 'number') {
        expect(typeof field.min).toBe('number')
        expect(typeof field.max).toBe('number')
        expect(typeof field.integer).toBe('boolean')
      }
      if (field.kind === 'select') expect(field.options?.length).toBeGreaterThan(0)
    }
    expect(KNOWLEDGE_FIELD_DEFS.chunkSize.max).toBe(8192)
  })

  it('与 settings store 的 knowledgeGlobalValues 键集合一致', () => {
    setActivePinia(createPinia())
    ;(globalThis as Record<string, unknown>).window = { api: {} }
    const values = useSettingsStore().knowledgeGlobalValues
    expect(Object.keys(values).sort()).toEqual([...KNOWLEDGE_OVERRIDE_KEYS].sort())
  })
})

describe('createDraft 草稿构造', () => {
  it('数值转字符串，布尔保持布尔，下拉保持原类型', () => {
    const draft = createDraft({
      chunkSize: 800,
      hybridWeight: 0.65,
      sparseRetrieval: false,
      vectorDimensions: 1024,
      chunkStrategy: 'semantic'
    })
    expect(draft.chunkSize).toBe('800')
    expect(draft.hybridWeight).toBe('0.65')
    expect(draft.sparseRetrieval).toBe(false)
    expect(draft.vectorDimensions).toBe(1024)
    expect(draft.chunkStrategy).toBe('semantic')
  })

  it('缺省项留空字符串 / false / 空字符串', () => {
    const draft = createDraft({})
    expect(draft.chunkSize).toBe('')
    expect(draft.sparseRetrieval).toBe(false)
    expect(draft.graphModel).toBe('')
    expect(Object.keys(draft)).toHaveLength(17)
  })

  it('草稿可被全局默认值完整回填', () => {
    const global = defaultSettings() as Record<string, unknown>
    const values: Record<string, unknown> = {}
    for (const key of KNOWLEDGE_OVERRIDE_KEYS) values[key] = global[`knowledge.${key}`]
    const draft = createDraft(values)
    expect(draft.chunkSize).toBe('800')
    expect(draft.topK).toBe('12')
    expect(draft.sparseRetrieval).toBe(true)
    expect(draft.vectorDimensions).toBe(1024)
  })
})

describe('parseNumber 区间校验', () => {
  it('拒绝空串 / 非数字 / 越界 / 非整数', () => {
    expect(parseNumber('', 1, 100, true)).toBeNull()
    expect(parseNumber('abc', 1, 100, true)).toBeNull()
    expect(parseNumber('101', 1, 100, true)).toBeNull()
    expect(parseNumber('1.5', 1, 100, true)).toBeNull()
  })

  it('接受边界值与非整数项', () => {
    expect(parseNumber('1', 1, 100, true)).toBe(1)
    expect(parseNumber('100', 1, 100, true)).toBe(100)
    expect(parseNumber('0.75', 0, 1, false)).toBe(0.75)
  })
})

describe('draftValueToOverride 单字段提交', () => {
  it('越界 / 非整数 / 空模型名 → 带字段名的错误', () => {
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.chunkSize, '99999')).toEqual({
      error: '「切片大小」需为 100~8192 之间的整数'
    })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.chunkSize, '1.5')).toHaveProperty('error')
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.embeddingModel, '  ')).toHaveProperty('error')
  })

  it('假值与边界值正常通过（0 / false / 1 不被吃掉）', () => {
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.bm25B, '0')).toEqual({ value: 0 })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.bm25K1, '0')).toEqual({ value: 0 })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.topK, '1')).toEqual({ value: 1 })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.rerankEnabled, false)).toEqual({
      value: false
    })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.sparseRetrieval, false)).toEqual({
      value: false
    })
  })

  it('下拉回落到候选项的原始类型', () => {
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.vectorDimensions, 1024)).toEqual({
      value: 1024
    })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.chunkStrategy, 'markdown')).toEqual({
      value: 'markdown'
    })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.chunkStrategy, 'bogus')).toHaveProperty(
      'error'
    )
  })

  it('支持自定义模型名（非候选项但非空）', () => {
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.embeddingModel, 'my-model')).toEqual({
      value: 'my-model'
    })
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.graphModel, '自建模型')).toEqual({
      value: '自建模型'
    })
  })

  it('数值项去空格后可提交', () => {
    expect(draftValueToOverride(KNOWLEDGE_FIELD_DEFS.chunkSize, ' 1200 ')).toEqual({ value: 1200 })
  })
})

beforeEach(() => {
  vi.restoreAllMocks()
})
