import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeStore } from '../../../src/renderer/src/store/knowledge'

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
})
