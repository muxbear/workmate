import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  DEFAULT_KB_QA_WIDTH,
  KB_QA_COLLAPSED_WIDTH,
  MIN_KB_QA_WIDTH,
  QA_TAB_KEY,
  buildQaPrompt,
  clampKbQaWidth,
  useKbQaStore,
} from '@/stores/kbQa'
import type { KBDoc, SearchResult } from '@/types/knowledgeBase'

/**
 * 问答区的状态机（知识库页右侧面板）。
 *
 * 四条不变式：
 *
 * 1. **首标签「问答」永远在、且关不掉**——它是这个面板存在的理由，关掉之后面板
 *    只剩一个"什么都没有"的空白；
 * 2. **同一篇文档只占一个标签**——反复点同一行不该堆出一排同名标签；
 * 3. **宽度始终落在合法区间**——拖到 0 或拖到把内容区挤没，都不是合法状态；
 * 4. **停止/换库之后，在途的检索结果不许再接着写回答**（会话序号作废）。
 */

const api = vi.hoisted(() => ({
  fetchKBPage: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '操作失败')),
}))
vi.mock('@/services/knowledgeBaseApi', () => api)

const stream = vi.hoisted(() => ({ sendStreamRequest: vi.fn() }))
vi.mock('@/services/request', () => stream)

function doc(overrides: Partial<KBDoc> = {}): KBDoc {
  return {
    id: 'doc-1',
    name: '报告.md',
    type: 'md',
    folder: null,
    size: '1 KB',
    status: 'indexed',
    progress: 100,
    chunks: 3,
    entities: 0,
    relations: 0,
    uploadedAt: '2026-09-26',
    errorMessage: null,
    graphError: null,
    parseWarning: null,
    stages: [],
    config: null,
    ...overrides,
  }
}

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'c1',
    docId: 'doc-1',
    doc: '报告.md',
    chunk: '上半年营收同比增长 12%。',
    chunkIndex: 0,
    score: 0.9,
    scoreKind: 'cosine',
    vec: 0.9,
    bm25: null,
    page: 3,
    section: '经营情况',
    kbId: 'kb-1',
    kbName: '产品手册',
    parentExpanded: false,
    ...overrides,
  }
}

/** 让 sendStreamRequest 立即"完成"（默认不吐 token） */
function streamOk() {
  stream.sendStreamRequest.mockResolvedValue(undefined)
}

beforeEach(() => {
  setActivePinia(createPinia())
  api.fetchKBPage.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 })
  api.searchKnowledgeBase.mockReset()
  stream.sendStreamRequest.mockReset()
  streamOk()
})

describe('kbQa · 标签页', () => {
  it('默认只激活「问答」标签', () => {
    const store = useKbQaStore()
    expect(store.activeKey).toBe(QA_TAB_KEY)
    expect(store.docTabs).toEqual([])
    expect(store.currentDocTab()).toBeNull()
  })

  it('开一个文档预览标签并激活它，同时把收起的问答区展开', () => {
    const store = useKbQaStore()
    expect(store.collapsed).toBe(true)

    store.openDocTab('kb-1', doc())
    expect(store.docTabs.map((t) => t.title)).toEqual(['报告.md'])
    expect(store.activeKey).toBe('doc:kb-1:doc-1')
    expect(store.currentDocTab()?.doc?.id).toBe('doc-1')
    expect(store.collapsed).toBe(false)
  })

  it('同一篇文档重复打开只占一个标签，并刷新快照', () => {
    const store = useKbQaStore()
    store.openDocTab('kb-1', doc({ status: 'parsing', chunks: 0 }))
    store.openDocTab('kb-1', doc({ status: 'indexed', chunks: 7 }))
    expect(store.docTabs).toHaveLength(1)
    expect(store.currentDocTab()?.doc?.chunks).toBe(7)
  })

  it('同名文档在不同知识库里是两个标签', () => {
    const store = useKbQaStore()
    store.openDocTab('kb-1', doc())
    store.openDocTab('kb-2', doc())
    expect(store.docTabs).toHaveLength(2)
  })

  it('关闭当前标签后回落到「问答」', () => {
    const store = useKbQaStore()
    store.openDocTab('kb-1', doc())
    store.closeTab('doc:kb-1:doc-1')
    expect(store.docTabs).toHaveLength(0)
    expect(store.activeKey).toBe(QA_TAB_KEY)
  })

  it('「问答」标签关不掉', () => {
    const store = useKbQaStore()
    store.closeTab(QA_TAB_KEY)
    expect(store.activeKey).toBe(QA_TAB_KEY)
  })
})

describe('kbQa · 面板宽度', () => {
  it('宽度被约束在 [最小宽度, 容器 - 内容区最小宽度] 之内', () => {
    expect(clampKbQaWidth(10, 1600)).toBe(MIN_KB_QA_WIDTH)
    // 1600 - 460 = 1140，远大于默认宽度，所以默认宽度原样保留
    expect(clampKbQaWidth(DEFAULT_KB_QA_WIDTH, 1600)).toBe(DEFAULT_KB_QA_WIDTH)
  })

  it('拖到把内容区挤没时不生效：宽度被压在「容器 - 内容区最小宽度」', () => {
    const store = useKbQaStore()
    store.syncShellWidth(1600)
    store.setPanelWidth(1400)   // 内容区会被挤到只剩 200px
    expect(store.panelWidth).toBe(1600 - 460)
  })

  it('容器窄到两边最小值打架时，保问答区自己的最小值', () => {
    const store = useKbQaStore()
    store.syncShellWidth(700)   // 700 - 460 = 240 < 320（问答区最小宽度）
    store.setPanelWidth(900)
    expect(store.panelWidth).toBe(MIN_KB_QA_WIDTH)
  })

  it('容器尚未测量时不把宽度压到下限以下', () => {
    const store = useKbQaStore()
    store.setPanelWidth(10)
    expect(store.panelWidth).toBe(MIN_KB_QA_WIDTH)
  })

  it('默认是收起的（进页面先只有知识库内容区）', () => {
    expect(useKbQaStore().collapsed).toBe(true)
  })

  it('全屏与折叠互斥：进全屏要先从收起态出来，收起时要退出全屏', () => {
    const store = useKbQaStore()
    store.toggleFullscreen()
    expect(store.fullscreen).toBe(true)
    expect(store.collapsed).toBe(false)   // 收着还全屏等于什么都没显示

    store.toggleCollapsed()
    expect(store.collapsed).toBe(true)
    expect(store.fullscreen).toBe(false)  // 不然下次展开直接铺满整页
  })

  it('展开只改标志位，宽度原样留着（收起再展开能还原）', () => {
    const store = useKbQaStore()
    store.syncShellWidth(1600)
    store.setPanelWidth(500)
    store.toggleCollapsed()
    expect(store.collapsed).toBe(false)
    expect(store.panelWidth).toBe(500)
    expect(KB_QA_COLLAPSED_WIDTH).toBeLessThan(MIN_KB_QA_WIDTH)
  })
})

describe('kbQa · 会话', () => {
  it('欢迎态：没有轮次', () => {
    expect(useKbQaStore().turns).toEqual([])
  })

  it('换知识库不清掉已有会话（只改"问谁"）', () => {
    const store = useKbQaStore()
    store.setKb('kb-1')
    store.turns = [
      { id: 't1', role: 'user', content: 'q', sources: [], noRelevant: false, retrieveError: '', pending: false, error: '' },
    ]
    store.setKb('kb-2')
    expect(store.kbId).toBe('kb-2')
    expect(store.turns).toHaveLength(1)
  })

  it('提问：先检索、再带着检索结果去生成，回答上挂着来源', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      results: [hit()], noRelevantResult: false,
      rerankRequested: false, rerankApplied: false, minSimilarity: 0.53,
      filteredCount: 0, dedupedCount: 0, searchedKbIds: ['kb-1'],
      rewriteRequested: false, rewriteApplied: false, rewriteQueries: [],
      rewriteHyde: false, rewriteReason: '',
    })
    let captured = ''
    stream.sendStreamRequest.mockImplementation(async (message: string)
      : Promise<void> => { captured = message })

    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('营收怎么样？')

    expect(api.searchKnowledgeBase).toHaveBeenCalledWith('kb-1', '营收怎么样？', 'hybrid', 5)
    // 检索到的正文必须进提示词，否则"基于知识库回答"就是空话
    expect(captured).toContain('上半年营收同比增长 12%')
    expect(captured).toContain('营收怎么样？')
    expect(store.turns).toHaveLength(2)
    expect(store.turns[1].sources).toHaveLength(1)
    expect(store.turns[1].pending).toBe(false)
    expect(store.streaming).toBe(false)
  })

  it('把选中的知识库下发给后端（kb_ids + knowledge 模式）', async () => {
    let captured: { kbIds: string[]; mode: string } | undefined
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { selection: { kbIds: string[]; mode: string } },
    ) => { captured = options.selection })

    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('问题')

    // 实测教训：只把检索结果拼进提示词、不下发 kb_ids 时，agent 会自己去列账号下的
    // 知识库并检索（回答跑题到别的库）。必须让后端把检索范围限定在选中的库上。
    expect(captured?.kbIds).toEqual(['kb-1'])
    expect(captured?.mode).toBe('knowledge')
  })

  it('没选知识库时不下发 kb_ids（不假装有检索范围）', async () => {
    let captured: { kbIds: string[]; mode: string } | undefined
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { selection: { kbIds: string[]; mode: string } },
    ) => { captured = options.selection })

    const store = useKbQaStore()
    await store.ask('问题')
    expect(captured?.kbIds).toEqual([])
    expect(captured?.mode).toBe('default')
  })

  it('流式 token 直接追加到当前回答', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      results: [], noRelevantResult: true,
      rerankRequested: false, rerankApplied: false, minSimilarity: null,
      filteredCount: 0, dedupedCount: 0, searchedKbIds: [],
      rewriteRequested: false, rewriteApplied: false, rewriteQueries: [],
      rewriteHyde: false, rewriteReason: '',
    })
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { callbacks: { onToken: (a: string, c: string) => void } },
    ) => {
      options.callbacks.onToken('agent', '答案')
      options.callbacks.onToken('agent', '如下')
    })

    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('问题')
    expect(store.turns[1].content).toBe('答案如下')
    expect(store.turns[1].noRelevant).toBe(true)
  })

  it('检索失败不阻断提问：失败原因留在回答上方，问题照常送出去', async () => {
    api.searchKnowledgeBase.mockRejectedValue(new Error('检索服务未就绪'))
    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('问题')

    expect(stream.sendStreamRequest).toHaveBeenCalled()
    expect(store.turns[1].retrieveError).toBe('检索服务未就绪')
    expect(store.turns[1].sources).toEqual([])
  })

  it('生成报错时错误挂在那一轮上，不吞掉', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      results: [], noRelevantResult: false,
      rerankRequested: false, rerankApplied: false, minSimilarity: null,
      filteredCount: 0, dedupedCount: 0, searchedKbIds: [],
      rewriteRequested: false, rewriteApplied: false, rewriteQueries: [],
      rewriteHyde: false, rewriteReason: '',
    })
    stream.sendStreamRequest.mockImplementation(async (
      _m: string,
      options: { callbacks: { onError: (m: string) => void } },
    ) => { options.callbacks.onError('模型不可用') })

    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('问题')
    expect(store.turns[1].error).toBe('模型不可用')
  })

  it('检索期间点了停止：不再发起生成，也不留下"生成中"的回答', async () => {
    let release: (value: unknown) => void = () => {}
    api.searchKnowledgeBase.mockReturnValue(
      new Promise((resolve) => { release = resolve }),
    )
    const store = useKbQaStore()
    store.setKb('kb-1')
    const pending = store.ask('问题')

    store.stop()
    release({
      results: [], noRelevantResult: false, rerankRequested: false,
      rerankApplied: false, minSimilarity: null, filteredCount: 0,
      dedupedCount: 0, searchedKbIds: [], rewriteRequested: false,
      rewriteApplied: false, rewriteQueries: [], rewriteHyde: false, rewriteReason: '',
    })
    await pending

    expect(stream.sendStreamRequest).not.toHaveBeenCalled()
    expect(store.turns[1].pending).toBe(false)
    expect(store.streaming).toBe(false)
  })

  it('停止会中止在途的生成请求', async () => {
    let signal: AbortSignal | undefined
    let release: () => void = () => {}
    stream.sendStreamRequest.mockImplementation(
      (_m: string, options: { signal?: AbortSignal }) => {
        signal = options.signal
        return new Promise<void>((resolve) => { release = resolve })
      },
    )

    const store = useKbQaStore()
    store.setKb('kb-1')
    const pending = store.ask('问题')
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    store.stop()
    expect(signal?.aborted).toBe(true)

    release()
    await pending
  })

  it('没有选知识库时不检索（也不假装有依据）', async () => {
    const store = useKbQaStore()
    await store.ask('问题')
    expect(api.searchKnowledgeBase).not.toHaveBeenCalled()
    expect(store.turns).toHaveLength(2)
  })

  it('空问题与生成中的重复提交都不生效', async () => {
    const store = useKbQaStore()
    store.setKb('kb-1')
    await store.ask('   ')
    expect(store.turns).toHaveLength(0)

    stream.sendStreamRequest.mockImplementation(() => new Promise(() => {}))
    void store.ask('第一问')
    await Promise.resolve()
    await store.ask('第二问')
    expect(store.turns.filter((t) => t.role === 'user')).toHaveLength(1)
  })
})

describe('kbQa · 提示词', () => {
  it('没有检索结果时原样透传问题，不编造上下文', () => {
    expect(buildQaPrompt('问题', [])).toBe('问题')
  })

  it('带序号、文档名与页码，便于模型标注来源', () => {
    const prompt = buildQaPrompt('问题', [hit()])
    expect(prompt).toContain('[1] 报告.md · 经营情况 · 第 3 页')
    expect(prompt).toContain('上半年营收同比增长 12%。')
    expect(prompt).toContain('【问题】\n问题')
  })
})
