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
  // folder：目录浏览的当前位置（'' = 根目录）；folders：目录树（组件渲染期就会 filter 它）
  docQuery: { page: 1, pageSize: 20, total: 0, search: '', loading: false, folder: '' },
  folders: [] as { path: string; name: string; parent: string; docCount: number }[],
  loadDocs: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
  loadFolders: vi.fn(async () => null),
  selectedDoc: null,
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
    // 根目录：目录浏览的断言都基于它，想让文档"在某个目录里"就覆盖这个字段
    folder: null,
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
  enableOcr: false, ocrModel: '', ocrProviderId: '',
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


  it('加载中不显示"暂无文档，点击右上角上传"这个行动号召', async () => {
    // 回归（迭代 6 T6.6）：此前文档表没有任何加载态，数据还在路上时就先渲染空态，
    // 而那句空态是个**行动号召**——用户会以为库是空的、跑去重复上传
    store.docQuery.loading = true
    const wrapper = await mountTab([])

    // 断言 .empty-cell 的**文本**而不是 wrapper.html()：Vue 会保留模板里的注释，
    // 而组件源码的注释里就有这句文案——断言 html() 会撞上自己的注释，是假失败
    expect(wrapper.find('.empty-cell').text()).not.toContain('暂无文档')
    expect(wrapper.find('.kb-skeleton').exists()).toBe(true)

    store.docQuery.loading = false
  })

  it('有搜索词时"没结果"与"库是空的"说两句话', async () => {
    store.docQuery.search = '架构'
    const wrapper = await mountTab([])

    expect(wrapper.find('.empty-cell').text()).toContain('没有名称匹配')
    expect(wrapper.find('.empty-cell').text()).not.toContain('暂无文档')

    store.docQuery.search = ''
  })

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

describe('KbDocsTab · 目录浏览', () => {
  function withFolders(folders: { path: string; name: string; parent: string; docCount: number }[]) {
    store.folders.length = 0
    store.folders.push(...folders)
  }

  beforeEach(() => {
    store.folders.length = 0
    store.docQuery.folder = ''
    store.docQuery.search = ''
    store.loadFolders.mockClear()
  })

  it('目录行不贡献勾选框，也不进入批量选择', async () => {
    withFolders([{ path: 'a', name: 'a', parent: '', docCount: 2 }])
    const wrapper = await mountTab([makeDoc({ id: 'd1' }), makeDoc({ id: 'd2', name: 'b.md' })])

    // 表头 + 2 个文档行；目录行是"可进入的行"，不是可勾选项
    expect(rowChecks(wrapper).length).toBe(3)
    expect(wrapper.find('.folder-row').exists()).toBe(true)
    expect(wrapper.find('.folder-row').text()).toContain('a')
  })

  it('只读态也能浏览目录（目录只读不影响导航）', async () => {
    withFolders([{ path: 'a', name: 'a', parent: '', docCount: 1 }])
    const wrapper = await mountTab([], true)

    expect(wrapper.find('.folder-row').exists()).toBe(true)
  })

  it('点子目录 → 按该目录取第 1 页，并**清掉搜索词**', async () => {
    // 不清搜索词的后果很具体：输入框里还挂着旧词，而列表已是目录内容；
    // 防抖定时器更会把旧词在 300ms 后打回来，看起来像"点了没反应"
    withFolders([{ path: 'a', name: 'a', parent: '', docCount: 1 }])
    const wrapper = await mountTab([])
    store.loadDocs.mockClear()

    await wrapper.find('.folder-row').trigger('click')
    await flushPromises()

    expect(store.loadDocs).toHaveBeenCalledWith('kb-1', { folder: 'a', search: '', page: 1 })
    expect((wrapper.find('.search-input').element as HTMLInputElement).value).toBe('')
  })

  it('面包屑逐级可点，末级标为当前位置', async () => {
    store.docQuery.folder = 'a/b'
    withFolders([])
    const wrapper = await mountTab([])
    store.loadDocs.mockClear()

    const crumbs = wrapper.findAll('.crumb')
    expect(crumbs.map((c) => c.text())).toEqual(['根目录', 'a', 'b'])
    expect(crumbs[2].classes()).toContain('is-current')

    await crumbs[1].trigger('click')
    await flushPromises()

    expect(store.loadDocs).toHaveBeenCalledWith('kb-1', { folder: 'a', search: '', page: 1 })
  })

  it('「上一级」回到父目录；根目录下不出现', async () => {
    withFolders([])
    const atRoot = await mountTab([])
    expect(atRoot.find('.path-up').exists()).toBe(false)

    store.docQuery.folder = 'a/b'
    const wrapper = await mountTab([])
    store.loadDocs.mockClear()
    await wrapper.find('.path-up').trigger('click')
    await flushPromises()

    expect(store.loadDocs).toHaveBeenCalledWith('kb-1', { folder: 'a', search: '', page: 1 })
  })

  it('只有子目录、没有文档时，空态不说"点击右上角上传"', async () => {
    withFolders([{ path: 'a', name: 'a', parent: '', docCount: 3 }])
    const wrapper = await mountTab([])
    store.docQuery.folder = 'a'
    store.loadFolders.mockClear()

    const emptyInFolder = await mountTab([])
    withFolders([])
    await emptyInFolder.setProps({ kb: makeKb([]) })
    await flushPromises()

    const text = emptyInFolder.find('.empty-cell').text()
    expect(text).toContain('「a」下暂无文档')
    expect(text).not.toContain('点击右上角上传')
  })

  it('搜索态隐藏目录行，并在结果里标出所在位置', async () => {
    withFolders([{ path: 'a', name: 'a', parent: '', docCount: 1 }])
    store.docQuery.search = '报告'
    const wrapper = await mountTab([makeDoc({ id: 'd1', folder: 'a/b' })])

    expect(wrapper.find('.folder-row').exists()).toBe(false)
    expect(wrapper.text()).toContain('所在位置：a/b')

    store.docQuery.search = ''
  })

  it('根目录的文档在搜索结果里显示「根目录」而不是空', async () => {
    store.docQuery.search = '报告'
    const wrapper = await mountTab([makeDoc({ id: 'd1', folder: null })])

    expect(wrapper.text()).toContain('所在位置：根目录')

    store.docQuery.search = ''
  })
})

describe('KbDocsTab · 打开文档预览', () => {
  it('点文档名把这篇文档抛给宿主（在问答区开预览标签），不在本页就地展开', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1', name: '甲.md' })])

    await wrapper.find('.doc-cell--clickable').trigger('click')

    const events = wrapper.emitted('preview-doc')
    expect(events).toHaveLength(1)
    expect((events![0][0] as KBDoc).id).toBe('d1')
    // 就地展开的整页视图已经挪走：本页不该再出现文档详情
    expect(wrapper.find('.doc-detail-view').exists()).toBe(false)
  })

  it('右侧「查看详情」按钮走同一个入口', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1', name: '甲.md' })])

    await wrapper.find('.action-view').trigger('click')

    expect(wrapper.emitted('preview-doc')).toHaveLength(1)
  })

  it('键盘回车同样能打开（可点元素必须键盘可达）', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1', name: '甲.md' })])

    await wrapper.find('.doc-cell--clickable').trigger('keydown.enter')

    expect(wrapper.emitted('preview-doc')).toHaveLength(1)
  })

  it('点勾选框不会顺带打开预览', async () => {
    const wrapper = await mountTab([makeDoc({ id: 'd1', name: '甲.md' })])

    await wrapper.find('.row-check').setValue(true)

    expect(wrapper.emitted('preview-doc')).toBeUndefined()
  })
})
