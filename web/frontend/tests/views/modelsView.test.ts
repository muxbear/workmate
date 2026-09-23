import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ModelsView from '@/views/ModelsView.vue'
import { useModelStore } from '@/stores/model'
import * as api from '@/services/modelApi'
import type { AIModel, Provider } from '@/types/model'

vi.mock('@/services/modelApi', () => ({
  fetchProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  reorderProviders: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deleteModel: vi.fn(),
  cloneModel: vi.fn(),
  reorderModels: vi.fn(),
  toggleModelStatus: vi.fn(),
  setDefaultModel: vi.fn(),
}))

function model(overrides: Partial<AIModel> = {}): AIModel {
  return {
    id: 'm1',
    name: 'glm-4-plus',
    displayName: 'GLM-4-Plus',
    type: 'llm',
    status: 'active',
    contextWindow: 128000,
    callCount: 12,
    params: [],
    description: '',
    isDefault: false,
    ...overrides,
  }
}

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: '智谱 AI',
    logo: '🤖',
    status: 'unconfigured',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    responseUrl: '',
    anthropicUrl: '',
    apiKey: 'sk-test',
    description: '国产大模型',
    website: '',
    models: [
      model({ id: 'm1', name: 'glm-4-plus', displayName: 'GLM-4-Plus', isDefault: true }),
      model({ id: 'm2', name: 'embedding-3', displayName: 'Embedding-3', type: 'embedding' }),
    ],
    ...overrides,
  }
}

async function mountView(providers: Provider[] = [provider()]) {
  vi.mocked(api.fetchProviders).mockResolvedValue(providers)
  const wrapper = mount(ModelsView, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

describe('ModelsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('右侧直接展示模型列表，不再有标签页与使用统计', async () => {
    const wrapper = await mountView()

    expect(wrapper.find('.models-content').exists()).toBe(true)
    expect(wrapper.find('.provider-tabs').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('使用统计')
    expect(wrapper.text()).not.toContain('模型列表')

    expect(wrapper.findAll('.model-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('GLM-4-Plus')
    expect(wrapper.text()).toContain('glm-4-plus')
  })

  it('提供商名字旁不再显示「未配置」状态', async () => {
    const wrapper = await mountView()

    expect(wrapper.find('.provider-header-name').text()).toBe('智谱 AI')
    expect(wrapper.find('.provider-status-dot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('未配置')
  })

  it('默认模型带「默认」标记，其余模型没有', async () => {
    const wrapper = await mountView()
    const badges = wrapper.findAll('.model-default-badge')

    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('默认')
    expect(badges[0].element.closest('.model-row')?.textContent).toContain('GLM-4-Plus')
  })

  it('设为默认模型后重新拉取列表，标记随之转移', async () => {
    const wrapper = await mountView()
    const store = useModelStore()

    vi.mocked(api.setDefaultModel).mockResolvedValue(model({ id: 'm2', isDefault: true }))
    vi.mocked(api.fetchProviders).mockResolvedValue([
      provider({
        models: [
          model({ id: 'm1', name: 'glm-4-plus', displayName: 'GLM-4-Plus' }),
          model({
            id: 'm2',
            name: 'glm-4-flash',
            displayName: 'GLM-4-Flash',
            isDefault: true,
          }),
        ],
      }),
    ])

    await store.setDefaultModel('p1', 'm2')
    await flushPromises()

    expect(api.setDefaultModel).toHaveBeenCalledWith('p1', 'm2')
    expect(api.fetchProviders).toHaveBeenCalledTimes(2)

    const badges = wrapper.findAll('.model-default-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].element.closest('.model-row')?.textContent).toContain('GLM-4-Flash')
  })
})
