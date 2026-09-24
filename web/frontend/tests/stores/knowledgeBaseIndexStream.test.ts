import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import type { KB, KBDoc } from '@/types/knowledgeBase'

const api = vi.hoisted(() => ({
  buildIndexingStreamUrl: vi.fn(),
  fetchDocuments: vi.fn(),
  fetchStats: vi.fn(),
  cancelDocument: vi.fn(),
  fetchKnowledgeBase: vi.fn(),
  fetchGraphData: vi.fn(),
}))

vi.mock('@/services/knowledgeBaseApi', () => api)

/** 极简 EventSource 替身：记录实例并在测试里手动投递消息 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }

  close() {
    this.closed = true
  }
}

function doc(overrides: Partial<KBDoc> = {}): KBDoc {
  return {
    id: 'doc-1',
    name: '文档.md',
    type: 'md',
    size: '1 KB',
    status: 'parsing',
    progress: 3,
    chunks: 0,
    entities: 0,
    relations: 0,
    uploadedAt: '2026-09-24',
    errorMessage: null,
    graphError: null,
    stages: [],
    config: null,
    ...overrides,
  }
}

function kb(documents: KBDoc[]): KB {
  return {
    id: 'kb-1',
    name: '库',
    description: '',
    status: 'indexing',
    docs: documents.length,
    chunks: 0,
    entities: 0,
    relations: 0,
    size: '1 KB',
    updatedAt: '2026-09-24',
    config: {} as KB['config'],
    documents,
    entitiesData: [],
    relationsData: [],
    tags: [],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
  }
}

describe('知识库索引进度：SSE 与兜底', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    api.buildIndexingStreamUrl.mockReset()
    api.fetchDocuments.mockReset().mockResolvedValue({ items: [] })
    api.fetchStats.mockReset().mockResolvedValue({
      totalKbs: 0, totalDocs: 0, totalChunks: 0, totalEntities: 0, indexing: 0,
    })
    api.cancelDocument.mockReset()
  })

  it('收到进度事件后增量更新文档状态与进度', async () => {
    api.buildIndexingStreamUrl.mockReturnValue('/api/knowledge-bases/kb-1/indexing/stream?token=t')
    const store = useKnowledgeBaseStore()
    store.selectedKb = kb([doc()])

    store.startIndexPolling()
    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0].emit({
      doc_id: 'doc-1',
      status: 'indexed',
      progress: 100,
      chunks_count: 42,
      error_message: null,
    })

    const updated = store.selectedKb?.documents[0]
    expect(updated?.status).toBe('indexed')
    expect(updated?.progress).toBe(100)
    expect(updated?.chunks).toBe(42)
    store.stopIndexPolling()
  })

  it('终止态事件触发兜底刷新（同步计数与列表）', async () => {
    api.buildIndexingStreamUrl.mockReturnValue('/stream?token=t')
    // 兜底刷新会用列表接口的结果覆盖本地列表，因此 mock 返回后端的最新状态
    api.fetchDocuments.mockResolvedValue({
      items: [doc({ status: 'failed', errorMessage: '解析失败' })],
    })
    const store = useKnowledgeBaseStore()
    store.selectedKb = kb([doc()])

    store.startIndexPolling()
    FakeEventSource.instances[0].emit({
      doc_id: 'doc-1', status: 'failed', progress: -1, chunks_count: 0,
      error_message: '解析失败',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(api.fetchDocuments).toHaveBeenCalledTimes(1)
    expect(store.selectedKb?.documents[0].status).toBe('failed')
    expect(store.selectedKb?.documents[0].errorMessage).toBe('解析失败')
    store.stopIndexPolling()
  })

  it('拿不到 stream 地址时回退轮询（有未完成文档才拉取）', async () => {
    vi.useFakeTimers()
    try {
      api.buildIndexingStreamUrl.mockReturnValue(null)
      const store = useKnowledgeBaseStore()
      store.selectedKb = kb([doc()])

      store.startIndexPolling()
      expect(FakeEventSource.instances).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(5000)
      expect(api.fetchDocuments).toHaveBeenCalledTimes(1)

      // 文档全部进入终态后不再拉取（本地状态已由上一次刷新更新）
      api.fetchDocuments.mockResolvedValue({ items: [doc({ status: 'indexed' })] })
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)
      expect(api.fetchDocuments).toHaveBeenCalledTimes(1)
      store.stopIndexPolling()
    } finally {
      vi.useRealTimers()
    }
  })

  it('停止订阅时关闭 EventSource', () => {
    api.buildIndexingStreamUrl.mockReturnValue('/stream?token=t')
    const store = useKnowledgeBaseStore()
    store.selectedKb = kb([doc()])

    store.startIndexPolling()
    const source = FakeEventSource.instances[0]
    store.stopIndexPolling()

    expect(source.closed).toBe(true)
  })

  it('取消文档后立即更新本地状态', async () => {
    api.cancelDocument.mockResolvedValue(doc({ status: 'canceled', errorMessage: '已取消索引' }))
    const store = useKnowledgeBaseStore()
    store.selectedKb = kb([doc()])

    await store.cancelDoc('kb-1', 'doc-1')

    expect(api.cancelDocument).toHaveBeenCalledWith('kb-1', 'doc-1')
    expect(store.selectedKb?.documents[0].status).toBe('canceled')
  })
})
