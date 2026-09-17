import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeStore } from '../../../src/renderer/src/store/knowledge'
import type { KnowledgeBaseSummary } from '../../../src/preload/index.d'

/** 最小知识库记录桩（只填排序 / 置顶用得上的字段） */
function base(id: string, pinned = false): KnowledgeBaseSummary {
  return {
    id,
    userId: 'user-1',
    name: id,
    description: '',
    kind: 'local',
    status: 'ready',
    docsCount: 0,
    sizeBytes: 0,
    sortOrder: 0,
    pinned,
    createdAt: 1,
    updatedAt: 1
  }
}

/** 用最小 window.api 桩驱动 store（只提供被测方法） */
function setWindowApi(api: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).window = { api }
}

describe('useKnowledgeStore（错误收敛）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('打开知识库目录：成功返回 true', async () => {
    setWindowApi({ openKnowledgeBaseDir: vi.fn(async () => ({ success: true, data: null })) })
    const store = useKnowledgeStore()
    await expect(store.openBaseDir('kb-1')).resolves.toBe(true)
  })

  it('打开知识库目录：主进程未注册通道（reject）不再静默，返回 false 并提示重启', async () => {
    setWindowApi({
      openKnowledgeBaseDir: vi.fn(async () => {
        throw new Error("Error invoking remote method 'knowledge:open-dir': No handler registered")
      })
    })
    const store = useKnowledgeStore()
    await expect(store.openBaseDir('kb-1')).resolves.toBe(false)
    expect(store.lastError).toContain('重启应用')
    expect(store.lastError).toContain('No handler registered')
  })

  it('打开文件目录：主进程返回失败时透出错误文案', async () => {
    setWindowApi({
      openKnowledgeFileDir: vi.fn(async () => ({ success: false, error: '文件不存在' }))
    })
    const store = useKnowledgeStore()
    await expect(store.openFileDir('kb-1', 'a.md')).resolves.toBe(false)
    expect(store.lastError).toBe('文件不存在')
  })

  it('列表加载：reject 时返回 false 且不抛异常', async () => {
    setWindowApi({
      listKnowledgeBases: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const store = useKnowledgeStore()
    await expect(store.loadBases()).resolves.toBe(false)
    expect(store.lastError).toContain('重启应用')
    expect(store.bases).toEqual([])
  })

  it('拖拽排序：成功时采用主进程返回的顺序', async () => {
    setWindowApi({
      reorderKnowledgeBases: vi.fn(async () => ({ success: true, data: [base('b'), base('a')] }))
    })
    const store = useKnowledgeStore()
    store.bases = [base('a'), base('b')]
    await expect(store.reorderBases('local', ['b', 'a'])).resolves.toBe(true)
    expect(store.bases.map((item) => item.id)).toEqual(['b', 'a'])
    expect(store.lastError).toBe('')
  })

  it('拖拽排序：失败时回退到主进程的列表（本地顺序不残留）', async () => {
    setWindowApi({
      reorderKnowledgeBases: vi.fn(async () => ({ success: false, error: '知识库列表已变化' })),
      listKnowledgeBases: vi.fn(async () => ({ success: true, data: [base('x')] }))
    })
    const store = useKnowledgeStore()
    store.bases = [base('a'), base('b')]
    await expect(store.reorderBases('local', ['b', 'a'])).resolves.toBe(false)
    expect(store.lastError).toBe('知识库列表已变化')
    expect(store.bases.map((item) => item.id)).toEqual(['x'])
  })

  it('置顶：成功时采用主进程返回的顺序（置顶项在最前）', async () => {
    setWindowApi({
      setKnowledgeBasePinned: vi.fn(async () => ({
        success: true,
        data: [base('b', true), base('a')]
      }))
    })
    const store = useKnowledgeStore()
    store.bases = [base('a'), base('b')]
    await expect(store.setPinned('b', true)).resolves.toBe(true)
    expect(store.bases.map((item) => item.id)).toEqual(['b', 'a'])
    expect(store.bases[0].pinned).toBe(true)
  })

  it('置顶：主进程返回失败时保留原列表并透出错误', async () => {
    setWindowApi({
      setKnowledgeBasePinned: vi.fn(async () => ({ success: false, error: '知识库不存在' }))
    })
    const store = useKnowledgeStore()
    store.bases = [base('a'), base('b')]
    await expect(store.setPinned('b', true)).resolves.toBe(false)
    expect(store.lastError).toBe('知识库不存在')
    expect(store.bases.map((item) => item.id)).toEqual(['a', 'b'])
  })
})
