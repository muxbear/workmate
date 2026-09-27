import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import KbQaTab from '@/components/knowledgeBase/KbQaTab.vue'
import { useKbQaStore } from '@/stores/kbQa'
import type { KB, SearchResult } from '@/types/knowledgeBase'

/**
 * 问答标签页的两个状态与"不 promise 空依据"的约束。
 *
 * 三件事：
 *
 * 1. **欢迎态 → 问答态**由"有没有轮次"驱动，提交问题后必须切过去；
 * 2. **没选知识库就不许提问**——这个面板的承诺是基于知识库回答，没有库可检索时
 *    悄悄退化成普通闲聊，用户会以为答案有出处；
 * 3. **来源要显示出来**，否则"基于知识库"只是一句话术。
 */

const api = vi.hoisted(() => ({
  fetchKBPage: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '操作失败')),
}))
vi.mock('@/services/knowledgeBaseApi', () => api)

vi.mock('@/services/modelApi', () => ({
  fetchProviders: vi.fn(async () => [
    {
      id: 'p1',
      name: '默认提供商',
      models: [
        { id: 'm1', name: 'deepseek-v3', displayName: 'DeepSeek V3', type: 'llm', status: 'active' },
      ],
    },
  ]),
}))

const stream = vi.hoisted(() => ({ sendStreamRequest: vi.fn() }))
vi.mock('@/services/request', () => stream)

function kb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1',
    name: '产品手册',
    description: '',
    status: 'ready',
    docs: 1,
    chunks: 10,
    entities: 0,
    relations: 0,
    size: '1 MB',
    updatedAt: '2026-09-26',
    config: {
      chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64, parentChunkSize: 1536,
      minChunkSize: 32, enableQueryRewrite: false, enableHyde: false,
      embeddingModel: 'e', embeddingProviderId: '', embeddingDim: 1024,
      sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75, entityModel: '', relationModel: '',
      enableGraph: false, rerankerModel: '', rerankerProviderId: '', enableReranker: false,
      topK: 5, hybridAlpha: 0.7, minSimilarity: 0.53, scoreThreshold: 0,
      maxChunksPerDoc: 3, dedupSimilarity: 0.92, enableOcr: false, ocrModel: '', ocrProviderId: '',
    },
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: [],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
    ...overrides,
  }
}

function hit(): SearchResult {
  return {
    id: 'c1', docId: 'doc-1', doc: '报告.md', chunk: '上半年营收同比增长 12%。',
    chunkIndex: 0, score: 0.9, scoreKind: 'cosine', vec: 0.9, bm25: null,
    page: 3, section: '经营情况', kbId: 'kb-1', kbName: '产品手册', parentExpanded: false,
  }
}

const emptyOutcome = {
  results: [] as SearchResult[], noRelevantResult: false, rerankRequested: false,
  rerankApplied: false, minSimilarity: null, filteredCount: 0, dedupedCount: 0,
  searchedKbIds: [], rewriteRequested: false, rewriteApplied: false,
  rewriteQueries: [], rewriteHyde: false, rewriteReason: '',
}

function factory() {
  return mount(KbQaTab)
}

/** 等到组件 mounted 里的两个异步加载（知识库列表 / 模型列表）落地 */
async function settle() {
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  api.fetchKBPage.mockReset().mockResolvedValue({
    items: [kb()], total: 1, page: 1, page_size: 100,
  })
  api.searchKnowledgeBase.mockReset().mockResolvedValue(emptyOutcome)
  stream.sendStreamRequest.mockReset().mockResolvedValue(undefined)
})

describe('KbQaTab · 欢迎态', () => {
  it('默认是欢迎态：标题、说明与建议问题，没有输入框以外的东西', async () => {
    const wrapper = factory()
    await settle()
    expect(wrapper.find('.qa-welcome').exists()).toBe(true)
    expect(wrapper.text()).toContain('基于知识库的问答')
    expect(wrapper.findAll('.suggestion').length).toBeGreaterThan(0)
  })

  it('点建议问题只是把问题填进输入框，不直接发出去', async () => {
    const wrapper = factory()
    await settle()
    await wrapper.findAll('.suggestion')[0].trigger('click')
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value)
      .toBe('这个知识库主要讲了什么？')
    expect(stream.sendStreamRequest).not.toHaveBeenCalled()
  })

  it('没选知识库时输入框禁用、发送按钮禁用，并给出提示', async () => {
    const wrapper = factory()
    await settle()
    const store = useKbQaStore()
    expect(store.kbId).toBe('')

    expect(wrapper.find('.composer-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.composer-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('请先选择要提问的知识库')
  })

  it('选完知识库后输入框可用', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    await settle()

    await wrapper.find('.picker-btn').trigger('click')
    await wrapper.findAll('.picker-option')[0].trigger('click')
    expect(store.kbId).toBe('kb-1')
    expect(wrapper.find('.composer-input').attributes('disabled')).toBeUndefined()
  })
})

describe('KbQaTab · 问答态', () => {
  it('提交问题后进入问答态，并显示回答与来源', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      ...emptyOutcome, results: [hit()],
    })
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { callbacks: { onToken: (a: string, c: string) => void } },
    ) => { options.callbacks.onToken('agent', '同比增长 **12%**。') })

    const store = useKbQaStore()
    const wrapper = factory()
    await settle()
    store.setKb('kb-1')
    await nextTick()
    await wrapper.find('.composer-input').setValue('营收怎么样？')
    await wrapper.find('.composer-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.qa-welcome').exists()).toBe(false)
    expect(wrapper.text()).toContain('营收怎么样？')
    // markdown 渲染：加粗生效，而不是把 ** 原样打出来
    expect(wrapper.find('.turn-markdown').html()).toContain('<strong>12%</strong>')
    // 来源列表：文档名 + 章节/页码
    expect(wrapper.find('.turn-sources').text()).toContain('报告.md')
    expect(wrapper.find('.turn-sources').text()).toContain('经营情况')
    expect(wrapper.find('.turn-sources').text()).toContain('第 3 页')
    // 输入框已清空，便于接着问
    expect((wrapper.find('.composer-input').element as HTMLTextAreaElement).value).toBe('')
  })

  it('回答里的 HTML 被转义，不会当成标签执行', async () => {
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { callbacks: { onToken: (a: string, c: string) => void } },
    ) => { options.callbacks.onToken('agent', '<img src=x onerror=alert(1)>') })

    const store = useKbQaStore()
    const wrapper = factory()
    await settle()
    store.setKb('kb-1')
    await nextTick()
    await wrapper.find('.composer-input').setValue('问题')
    await wrapper.find('.composer-btn').trigger('click')
    await flushPromises()

    const html = wrapper.find('.turn-markdown').html()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('检索失败时把原因摆在回答上方', async () => {
    api.searchKnowledgeBase.mockRejectedValue(new Error('检索服务未就绪'))
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { callbacks: { onToken: (a: string, c: string) => void } },
    ) => { options.callbacks.onToken('agent', '兜底回答') })

    const store = useKbQaStore()
    const wrapper = factory()
    await settle()
    store.setKb('kb-1')
    await nextTick()
    await wrapper.find('.composer-input').setValue('问题')
    await wrapper.find('.composer-btn').trigger('click')
    await flushPromises()

    expect(wrapper.find('.turn-note--warn').text()).toContain('检索服务未就绪')
    expect(wrapper.text()).toContain('兜底回答')
  })

  it('有会话后才出现「新会话」，点了就回到欢迎态', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    await settle()
    store.setKb('kb-1')
    await nextTick()
    expect(wrapper.find('.qa-new-btn').exists()).toBe(false)

    await wrapper.find('.composer-input').setValue('问题')
    await wrapper.find('.composer-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.qa-new-btn').exists()).toBe(true)

    await wrapper.find('.qa-new-btn').trigger('click')
    expect(wrapper.find('.qa-welcome').exists()).toBe(true)
  })

  it('模型下拉列出可用模型，选择后写回会话', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    await settle()
    expect(wrapper.text()).toContain('默认模型')

    const pickers = wrapper.findAll('.picker-btn')
    await pickers[1].trigger('click')
    const options = wrapper.findAll('.picker-option')
    await options[options.length - 1].trigger('click')
    expect(store.model).toBe('DeepSeek V3')
    expect(store.modelId).toBe('m1')
  })
})
