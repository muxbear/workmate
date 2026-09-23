import { beforeEach, describe, expect, it } from 'vitest'
import { MODEL_TYPE_META, getModelTypeMeta, registerModelTypeOptions } from '@/types/model'

/**
 * 模型类型改为「参数配置」驱动后，模板里的 `MODEL_TYPE_META[type]` 直接索引
 * 会在管理员新增类型时返回 undefined 并崩在 `.bg` 上，因此统一走
 * getModelTypeMeta()。这里守护它的兜底与标签覆盖行为。
 */
describe('getModelTypeMeta', () => {
  beforeEach(() => {
    registerModelTypeOptions([])
  })

  it('内置类型返回内置元数据', () => {
    const meta = getModelTypeMeta('llm')
    expect(meta.label).toBe(MODEL_TYPE_META.llm.label)
    expect(meta.emoji).toBe(MODEL_TYPE_META.llm.emoji)
    expect(meta.bg).toBe(MODEL_TYPE_META.llm.bg)
  })

  it('rerank 等新增内置类型可用', () => {
    expect(getModelTypeMeta('rerank').label).toBe('重排序模型')
  })

  it('自定义类型不会返回 undefined，而是走兜底样式', () => {
    const meta = getModelTypeMeta('voice-clone')
    expect(meta).toBeTruthy()
    expect(meta.bg).toBeTruthy()
    expect(meta.border).toBeTruthy()
    expect(meta.color).toBeTruthy()
    expect(meta.emoji).toBeTruthy()
  })

  it('自定义类型默认以编码作为标签', () => {
    expect(getModelTypeMeta('voice-clone').label).toBe('voice-clone')
  })

  it('参数配置下发的标签覆盖内置展示名', () => {
    registerModelTypeOptions([{ value: 'llm', label: '对话大模型' }])
    const meta = getModelTypeMeta('llm')
    expect(meta.label).toBe('对话大模型')
    // 配色仍取内置值
    expect(meta.bg).toBe(MODEL_TYPE_META.llm.bg)
  })

  it('参数配置下发的标签用于自定义类型', () => {
    registerModelTypeOptions([{ value: 'voice-clone', label: '声音克隆' }])
    expect(getModelTypeMeta('voice-clone').label).toBe('声音克隆')
  })

  it('重新登记会替换上一次的标签', () => {
    registerModelTypeOptions([{ value: 'llm', label: '旧名' }])
    registerModelTypeOptions([{ value: 'llm', label: '新名' }])
    expect(getModelTypeMeta('llm').label).toBe('新名')
  })

  it('空值安全', () => {
    expect(getModelTypeMeta('').label).toBe('未知类型')
    expect(getModelTypeMeta(undefined).label).toBe('未知类型')
    expect(getModelTypeMeta(null).label).toBe('未知类型')
  })

  it('空白编码按未知处理', () => {
    expect(getModelTypeMeta('   ').label).toBe('未知类型')
  })

  it('忽略缺少 value 的选项', () => {
    registerModelTypeOptions([
      { value: '', label: '无编码' },
      { value: 'llm', label: '' },
    ])
    expect(getModelTypeMeta('llm').label).toBe('llm')
  })
})

describe('MODEL_TYPE_META 注册表', () => {
  it('覆盖所有内置类型', () => {
    expect(Object.keys(MODEL_TYPE_META).sort()).toEqual([
      'audio',
      'embedding',
      'image-gen',
      'llm',
      'multimodal',
      'rerank',
      'speech',
      'video',
      'vision',
    ])
  })

  it('每项都具备完整展示字段', () => {
    for (const meta of Object.values(MODEL_TYPE_META)) {
      expect(meta.label).toBeTruthy()
      expect(meta.color).toBeTruthy()
      expect(meta.bg).toBeTruthy()
      expect(meta.border).toBeTruthy()
      expect(meta.emoji).toBeTruthy()
    }
  })
})
