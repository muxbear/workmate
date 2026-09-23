import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelStore } from '@/stores/model'
import * as api from '@/services/modelApi'
import { MODEL_TYPE_META, getModelTypeMeta, registerModelTypeOptions } from '@/types/model'

vi.mock('@/services/modelApi', () => ({
  fetchProviders: vi.fn(),
  fetchModelTypes: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  reorderProviders: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  cloneModel: vi.fn(),
  toggleModelStatus: vi.fn(),
  setDefaultModel: vi.fn(),
  reorderModels: vi.fn(),
}))

const mocked = vi.mocked(api)

describe('模型类型来自「参数配置」', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    registerModelTypeOptions([])
  })

  it('fetchAll 同时拉取提供商与模型类型', async () => {
    mocked.fetchProviders.mockResolvedValue([])
    mocked.fetchModelTypes.mockResolvedValue([
      { value: 'llm', label: '大语言模型' },
      { value: 'voice-clone', label: '声音克隆' },
    ])

    const store = useModelStore()
    await store.fetchAll()

    expect(mocked.fetchModelTypes).toHaveBeenCalled()
    expect(store.modelTypes).toEqual([
      { value: 'llm', label: '大语言模型' },
      { value: 'voice-clone', label: '声音克隆' },
    ])
  })

  it('拉取到的标签会覆盖内置展示名', async () => {
    mocked.fetchProviders.mockResolvedValue([])
    mocked.fetchModelTypes.mockResolvedValue([{ value: 'llm', label: '对话大模型' }])

    const store = useModelStore()
    await store.fetchAll()

    expect(getModelTypeMeta('llm').label).toBe('对话大模型')
  })

  it('自定义类型在下拉中可用且不会让界面取到 undefined', async () => {
    mocked.fetchProviders.mockResolvedValue([])
    mocked.fetchModelTypes.mockResolvedValue([{ value: 'voice-clone', label: '声音克隆' }])

    const store = useModelStore()
    await store.fetchAll()

    expect(store.modelTypes.map((o) => o.value)).toContain('voice-clone')
    expect(getModelTypeMeta('voice-clone').label).toBe('声音克隆')
    expect(getModelTypeMeta('voice-clone').bg).toBeTruthy()
  })

  it('接口失败时回退内置类型，模型页面仍可用', async () => {
    mocked.fetchProviders.mockResolvedValue([])
    mocked.fetchModelTypes.mockRejectedValue(new Error('403'))

    const store = useModelStore()
    await store.fetchAll()

    expect(store.modelTypes.length).toBe(Object.keys(MODEL_TYPE_META).length)
    expect(store.modelTypes.map((o) => o.value)).toContain('llm')
    expect(store.error).toBeNull()
  })

  it('提供商列表失败时不影响错误提示语义', async () => {
    mocked.fetchProviders.mockRejectedValue(new Error('网络错误'))
    mocked.fetchModelTypes.mockResolvedValue([{ value: 'llm', label: '大语言模型' }])

    const store = useModelStore()
    await store.fetchAll()

    expect(store.error).toBe('网络错误')
  })
})
