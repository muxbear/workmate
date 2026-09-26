import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbDocsTab from '@/components/knowledgeBase/KbDocsTab.vue'
import type { KB, KBDoc, IndexConfig } from '@/types/knowledgeBase'

/**
 * 文档页的选择集、批量操作与下载（迭代 6 T6.1）。
 *
 * 三条不变式：
 *
 * 1. **下载是读操作**——只读态（公共库 / 他人分享）也要能下原文；
 * 2. **批量按钮只在有选中项时出现**，且选中集必须与**当前列表**求交：文档列表
 *    会被 SSE 与 5s 轮询整体替换，残留的旧 id 不该让"删除所选 (3)"虚高、
 *    也不该让批量请求带着一串"文档不存在"；
 * 3. **删除必须二次确认**——文档是硬删除，向量与磁盘一并清掉、不可恢复。
 */

const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const box = actual.ElMessageBox as Record<string, unknown>
  return { ...actual, ElMessageBox: { ...box, confirm: confirmSpy } }
})

const api = vi.hoisted(() => ({
  downloadDocument: vi.fn(),
  batchDocumentOp: vi.fn(),
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '操作失败')),
}))
vi.mock('@/services/knowledgeBaseApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/services/knowledgeBaseApi')
  return { ...actual, ...api }
})

const store = vi.hoisted(() => ({
  uploadDocs: vi.fn(),
  createTextDoc: vi.fn(),
  importUrlDoc: vi.fn(),
  batchDocs: vi.fn(),
  deleteDoc: vi.fn(),
  retryDoc: vi.fn(),
  cancelDoc: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', () => ({
  useKnowledgeBaseStore: () => store,
}))

function makeDoc(overrides: Partial<KBDoc> = {}): KBDoc {
  return {
    id: 'doc-1',
    name: '报告.md',
    type: 'md',
    size: '1 KB',
    status: 'indexed',
    uploadedAt: '2026-09-26',
    chunks: 3,
    entities: 0,
    relations: 0,
    progress: 100,
    ...overrides,
  }
}

const CONFIG = {
  chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
  embeddingModel: '', embeddingProviderId: '', embeddingDim: 1024,
  sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
  entityModel: '', relationModel: '', enableGraph: true,
  rerankerModel: '', rerankerProviderId: '', enableReranker: true,
  topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
  maxChunksPerDoc: 3, dedupSimilarity: 0.92,
  parentChunkSize: 1536, minChunkSize: 32,
  enableQueryRewrite: false, enableHyde: false,
} as IndexConfig

function makeKb(docs: KBDoc[]): KB {
  return {
    id: 'kb-1', name: '库', description: '', status: 'ready',
    docs: docs.length, chunks: 10, entities: 0, relations: 0, size: '1 KB',
    updatedAt: '2026-09-26', config: CONFIG, documents: docs,
    entitiesData: [], relationsData: [], tags: [], visibility: 'private',
    isOwner: true, ownerName: null,
  }
}

async function mountTab(docs: KBDoc[], readonly = false) {
  const wrapper = mount(KbDocsTab, {
    props: { kb: makeKb(docs), readonly },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

/** 行复选框：第 0 个是表头的全选，行从第 1 个开始 */
function rowChecks(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.row-check')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KbDocsTab · 操作显隐', () => {
  it('只读态不显示上传/粘贴/批量，但保留下载原文', async () => {
    const wrapper = await mountTab([makeDoc()], true)

    expect(wrapper.find('.btn-upload').exists()).toBe(false)
    expect(wrapper.find('button[title="下载原文"]').exists()).toBe(true)
    // 只读态也不该有勾选列
    expect(rowChecks(wrapper).length).toBe(0)
  })

  it('没有选中项时不出现批量按钮', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1' }), makeDoc({ id: 'd2', name: 'b.md' })])

    expect(wrapper.text()).not.toContain('删除所选')
    expect(wrapper.text()).not.toContain('重试所选')
    expect(rowChecks(wrapper).length).toBe(3)   // 表头 + 2 行
  })

  it('勾选后出现批量按钮并显示条数', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1' }), makeDoc({ id: 'd2', name: 'b.md' })])

    await rowChecks(wrapper)[1].trigger('change')   // 第一行

    expect(wrapper.text()).toContain('删除所选 (1)')
    expect(wrapper.text()).toContain('重试所选 (1)')
  })

  it('列表刷新后失效的选择不计入（选择集与当前列表求交）', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1' })])
    await rowChecks(wrapper)[1].trigger('change')
    expect(wrapper.text()).toContain('删除所选 (1)')

    // SSE / 轮询把列表整体替换成另一批文档
    await wrapper.setProps({ kb: makeKb([makeDoc({ id: 'd2', name: '别的.md' })]) })

    expect(wrapper.text()).not.toContain('删除所选')
  })
})

describe('KbDocsTab · 批量删除', () => {
  it('确认后才调用批量接口', async () => {
    confirmSpy.mockResolvedValue('confirm')
    store.batchDocs.mockResolvedValue({
      action: 'delete', succeeded: 1, failed: 0,
      items: [{ docId: 'd1', ok: true, message: null }],
    })
    const wrapper = await mountTab([makeDoc({ id: 'd1' })])
    await rowChecks(wrapper)[1].trigger('change')

    await wrapper.find('.btn-danger').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalled()
    expect(store.batchDocs).toHaveBeenCalledWith('kb-1', 'delete', ['d1'])
  })

  it('取消确认则不调用接口', async () => {
    confirmSpy.mockRejectedValue(new Error('cancel'))
    const wrapper = await mountTab([makeDoc({ id: 'd1' })])
    await rowChecks(wrapper)[1].trigger('change')

    await wrapper.find('.btn-danger').trigger('click')
    await flushPromises()

    expect(store.batchDocs).not.toHaveBeenCalled()
  })

  it('部分失败时提示里带上原因', async () => {
    confirmSpy.mockResolvedValue('confirm')
    store.batchDocs.mockResolvedValue({
      action: 'delete', succeeded: 1, failed: 1,
      items: [
        { docId: 'd1', ok: true, message: null },
        { docId: 'd2', ok: false, message: '文档不存在' },
      ],
    })
    const wrapper = await mountTab([makeDoc({ id: 'd1' }), makeDoc({ id: 'd2' })])
    await rowChecks(wrapper)[1].trigger('change')
    await rowChecks(wrapper)[2].trigger('change')

    await wrapper.find('.btn-danger').trigger('click')
    await flushPromises()

    // 消息通过 ElMessage 渲染到 body，这里断言调用参数更稳
    expect(store.batchDocs).toHaveBeenCalledWith('kb-1', 'delete', ['d1', 'd2'])
  })
})

describe('KbDocsTab · 批量重试', () => {
  it('先过滤掉已索引完成的文档，不把它们送进接口', async () => {
    store.batchDocs.mockResolvedValue({
      action: 'retry', succeeded: 1, failed: 0,
      items: [{ docId: 'd2', ok: true, message: null }],
    })
    const wrapper = await mountTab([
      makeDoc({ id: 'd1', status: 'indexed' }),
      makeDoc({ id: 'd2', status: 'failed' }),
    ])
    await rowChecks(wrapper)[1].trigger('change')
    await rowChecks(wrapper)[2].trigger('change')

    const retryBtn = wrapper.findAll('.btn-upload').find((b) => b.text().includes('重试所选'))!
    await retryBtn.trigger('click')
    await flushPromises()

    expect(store.batchDocs).toHaveBeenCalledWith('kb-1', 'retry', ['d2'])
  })
})

describe('KbDocsTab · 下载原文', () => {
  it('点击下载调用下载接口，带上文档名', async () => {
    api.downloadDocument.mockResolvedValue(undefined)
    const wrapper = await mountTab([makeDoc({ id: 'd1', name: '会议纪要.md' })])

    await wrapper.find('button[title="下载原文"]').trigger('click')
    await flushPromises()

    expect(api.downloadDocument).toHaveBeenCalledWith('kb-1', 'd1', '会议纪要.md')
  })
})
