import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbSearchTab from '@/components/knowledgeBase/KbSearchTab.vue'
import type { KB, SearchOutcome, SearchResult } from '@/types/knowledgeBase'

const api = vi.hoisted(() => ({ searchKnowledgeBase: vi.fn() }))
vi.mock('@/services/knowledgeBaseApi', () => api)

function kb(): KB {
  return {
    id: 'kb-1',
    name: '库',
    description: '',
    status: 'ready',
    docs: 1,
    chunks: 10,
    entities: 0,
    relations: 0,
    size: '1 KB',
    updatedAt: '2026-09-24',
    config: {
      chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
      embeddingModel: 'text-embedding-v4', embeddingProviderId: '',
      embeddingDim: 1024, sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
      entityModel: '', relationModel: '', enableGraph: true,
      rerankerModel: 'qwen3.7-text-rerank', rerankerProviderId: '',
      enableReranker: true, topK: 10, hybridAlpha: 0.5,
      minSimilarity: 0.53, scoreThreshold: 0,
      maxChunksPerDoc: 3, dedupSimilarity: 0.92,
    },
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: [],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
  }
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'c1',
    docId: 'd1',
    doc: '手册.md',
    chunk: '命中内容',
    chunkIndex: 4,
    score: 0.72,
    scoreKind: 'rerank',
    vec: 0.81,
    bm25: null,
    page: 12,
    section: '第 3 章 · 部署',
    ...overrides,
  }
}

function outcome(overrides: Partial<SearchOutcome> = {}): SearchOutcome {
  return {
    results: [result()],
    rerankRequested: true,
    rerankApplied: true,
    noRelevantResult: false,
    minSimilarity: 0.53,
    filteredCount: 0,
    dedupedCount: 0,
    ...overrides,
  }
}

async function mountTab() {
  const wrapper = mount(KbSearchTab, { props: { kb: kb() } })
  await flushPromises()
  return wrapper
}

async function search(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('input.q-input').setValue('怎么部署')
  await wrapper.find('button.btn-search').trigger('click')
  await flushPromises()
}

describe('KbSearchTab · 分数口径与引用', () => {
  beforeEach(() => {
    api.searchKnowledgeBase.mockReset()
  })

  it('结果卡按 score_kind 标注分数含义，并展示原始分与引用', async () => {
    api.searchKnowledgeBase.mockResolvedValue(outcome())
    const wrapper = await mountTab()

    await search(wrapper)

    const html = wrapper.html()
    expect(html).toContain('精排相关度')   // 不再一律叫"综合分"
    expect(html).toContain('0.720')
    expect(html).toContain('余弦 0.810')    // 原始分如实展示
    expect(html).toContain('第 3 章 · 部署') // 章节引用
    expect(html).toContain('第 12 页')       // 页码引用
    expect(html).toContain('高相关')
  })

  it('融合排序分不冒充相关度，只标"排序靠前/靠后"', async () => {
    api.searchKnowledgeBase.mockResolvedValue(outcome({
      results: [
        result({ scoreKind: 'rrf', score: 1.0, vec: 0.8, bm25: 6.0, page: null, section: '' }),
        result({ id: 'c2', scoreKind: 'rrf', score: 0.6 }),
      ],
    }))
    const wrapper = await mountTab()

    await search(wrapper)

    const html = wrapper.html()
    expect(html).toContain('融合排序分')
    expect(html).toContain('排序靠前')
    expect(html).not.toContain('高相关')
  })

  it('判定"库中没有相关内容"时给出明确说明，而不是"命中 0 条"', async () => {
    api.searchKnowledgeBase.mockResolvedValue(outcome({
      results: [],
      noRelevantResult: true,
      filteredCount: 8,
      rerankApplied: false,
    }))
    const wrapper = await mountTab()

    await search(wrapper)

    const html = wrapper.html()
    expect(html).toContain('知识库中没有找到相关内容')
    expect(html).toContain('0.53')
    expect(html).toContain('过滤 8 条')
  })

  it('精排未生效时显式告警', async () => {
    api.searchKnowledgeBase.mockResolvedValue(outcome({
      results: [result(), result({ id: 'c2' })],
      rerankRequested: true,
      rerankApplied: false,
    }))
    const wrapper = await mountTab()

    await search(wrapper)

    expect(wrapper.html()).toContain('未生效')
  })
})

describe('KbSearchTab · 高级参数', () => {
  beforeEach(() => {
    api.searchKnowledgeBase.mockReset()
    api.searchKnowledgeBase.mockResolvedValue(outcome())
  })

  it('默认把知识库配置的 Top-K 与精排开关传下去', async () => {
    const wrapper = await mountTab()

    await search(wrapper)

    const [kbId, query, mode, topK, params] = api.searchKnowledgeBase.mock.calls[0]
    expect(kbId).toBe('kb-1')
    expect(query).toBe('怎么部署')
    expect(mode).toBe('hybrid')
    expect(topK).toBe(10)
    expect(params.enableRerank).toBe(true)
  })

  it('展开高级参数后可覆盖 Top-K 与相似度门槛', async () => {
    const wrapper = await mountTab()

    await wrapper.find('button.link-btn').trigger('click')
    await flushPromises()
    expect(wrapper.html()).toContain('最低相似度')

    // 直接改内部状态：滑块拖拽在 jsdom 里没有真实几何，这里验证"参数确实被传下去"
    const vm = wrapper.vm as unknown as { advanced: { topK: number; minSimilarity: number } }
    vm.advanced.topK = 20
    vm.advanced.minSimilarity = 0.4
    await flushPromises()

    await search(wrapper)

    const call = api.searchKnowledgeBase.mock.calls[0]
    expect(call[3]).toBe(20)
    expect(call[4].minSimilarity).toBe(0.4)
  })

  it('关掉精排开关后请求里带上 false', async () => {
    const wrapper = await mountTab()

    const vm = wrapper.vm as unknown as { advanced: { enableRerank: boolean } }
    vm.advanced.enableRerank = false
    await flushPromises()

    await search(wrapper)

    expect(api.searchKnowledgeBase.mock.calls[0][4].enableRerank).toBe(false)
  })

  it('去冗余参数随请求下发，并在结果区显示丢弃条数', async () => {
    api.searchKnowledgeBase.mockResolvedValue(outcome({ dedupedCount: 4 }))
    const wrapper = await mountTab()

    await search(wrapper)

    const params = api.searchKnowledgeBase.mock.calls[0][4]
    expect(params.dedupSimilarity).toBe(0.92)
    expect(params.maxChunksPerDoc).toBe(0)
    expect(wrapper.html()).toContain('已去冗余 4 条')
  })

  it('检索失败时页面上留下错误原因，而不是只有一闪而过的 toast', async () => {
    api.searchKnowledgeBase.mockRejectedValue(new Error('向量库未初始化'))
    const wrapper = await mountTab()

    await search(wrapper)

    expect(wrapper.html()).toContain('向量库未初始化')
  })
})
