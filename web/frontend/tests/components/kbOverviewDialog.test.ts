import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbOverviewDialog from '@/components/knowledgeBase/KbOverviewDialog.vue'
import type { KB, KBDoc, IndexConfig } from '@/types/knowledgeBase'

/**
 * 「查看详情」弹窗（原"概览"页签的内容）。
 *
 * 它取代了详情页的"概览"页签，是左栏**每个分组**都能打开的入口，所以有三条不能破：
 *
 * 1. **自己拉数据**：列表项里没有文档（`mapKB` 把 `documents` 写死成空数组），
 *    不补一页文档的话"最近索引活动"永远显示"暂无文档"；
 * 2. **不碰 store 的选中态**：调 `selectKb` 会把弹窗背后的详情页一起换掉、还会开 SSE；
 * 3. 打开失败（库被删/无权限）要说清，而不是弹个空壳。
 */

const api = vi.hoisted(() => ({
  fetchKnowledgeBase: vi.fn(),
  fetchDocuments: vi.fn(),
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '加载失败')),
}))

vi.mock('@/services/knowledgeBaseApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/services/knowledgeBaseApi')
  return { ...actual, ...api }
})

const store = vi.hoisted(() => ({
  docQuery: { page: 1, pageSize: 20, total: 0, search: '', loading: false, folder: '' },
  selectKb: vi.fn(),
}))

vi.mock('@/stores/knowledgeBase', () => ({
  useKnowledgeBaseStore: () => store,
}))

const CONFIG = {
  chunkStrategy: 'recursive',
  chunkSize: 512,
  chunkOverlap: 64,
  embeddingModel: '',
  embeddingProviderId: '',
  embeddingDim: 1024,
  sparseAlgo: 'bm25',
  bm25K1: 1.5,
  bm25B: 0.75,
  entityModel: '',
  relationModel: '',
  enableGraph: true,
  rerankerModel: '',
  rerankerProviderId: '',
  enableReranker: true,
  topK: 10,
  hybridAlpha: 0.5,
  minSimilarity: 0.53,
  scoreThreshold: 0,
  maxChunksPerDoc: 3,
  dedupSimilarity: 0.92,
  enableOcr: false,
  ocrModel: '',
  ocrProviderId: '',
  parentChunkSize: 1536,
  minChunkSize: 32,
  enableQueryRewrite: false,
  enableHyde: false,
} as IndexConfig

function makeKb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1',
    name: '产品知识库',
    description: '本库放着产品文档',
    status: 'ready',
    docs: 12,
    chunks: 340,
    entities: 8,
    relations: 5,
    size: '2 MB',
    updatedAt: '2026-09-26',
    config: CONFIG,
    // 后端返回的 KB 里文档是空的（见 mapKB）——弹窗必须自己补齐
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: ['产品', '技术'],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
    ...overrides,
  }
}

function makeDoc(overrides: Partial<KBDoc> = {}): KBDoc {
  return {
    id: 'd1',
    name: '最近的一篇.md',
    type: 'md',
    size: '1 KB',
    status: 'indexed',
    progress: 100,
    chunks: 3,
    entities: 0,
    relations: 0,
    uploadedAt: '2026-09-26',
    folder: null,
    ...overrides,
  } as KBDoc
}

async function mountDialog(visible = true, kbId: string | null = 'kb-1') {
  const wrapper = mount(KbOverviewDialog, {
    props: { visible, kbId },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchKnowledgeBase.mockResolvedValue(makeKb())
  api.fetchDocuments.mockResolvedValue({ items: [makeDoc()], total: 1, page: 1, page_size: 5 })
})

describe('KbOverviewDialog · 数据拼装', () => {
  it('概览里的"最近索引活动"来自单独取的文档页，而不是 KB 里的空数组', async () => {
    const wrapper = await mountDialog()

    expect(api.fetchDocuments).toHaveBeenCalledWith('kb-1', { page: 1, page_size: 5 })
    // 不传 folder：最近活动是全库口径，与从哪个目录打开无关
    const [, params] = api.fetchDocuments.mock.calls[0]
    expect(params.folder).toBeUndefined()
    expect(wrapper.text()).toContain('最近的一篇.md')
    expect(wrapper.text()).not.toContain('暂无文档')
  })

  it('统计卡与标签取自该库，标题是库名', async () => {
    const wrapper = await mountDialog()

    expect(wrapper.text()).toContain('产品知识库')
    expect(wrapper.text()).toContain('340') // 分片
    expect(wrapper.text()).toContain('产品')
    expect(wrapper.text()).toContain('本库放着产品文档')
  })

  it('绝不触碰 store 的选中态（弹窗不该换掉背后的详情页）', async () => {
    await mountDialog()

    expect(store.selectKb).not.toHaveBeenCalled()
  })
})

describe('KbOverviewDialog · 状态与边界', () => {
  it('打开时才请求，关闭时不请求', async () => {
    await mountDialog(false, 'kb-1')

    expect(api.fetchKnowledgeBase).not.toHaveBeenCalled()
  })

  it('知识库不存在（接口返回空）时给出明确文案', async () => {
    api.fetchKnowledgeBase.mockResolvedValue(null)
    const wrapper = await mountDialog()

    expect(wrapper.text()).toContain('不存在或无权查看')
  })

  it('接口报错时把原因显示出来，而不是空壳', async () => {
    api.fetchKnowledgeBase.mockRejectedValue(new Error('请求失败（HTTP 404）'))
    const wrapper = await mountDialog()

    expect(wrapper.text()).toContain('请求失败（HTTP 404）')
  })
})
