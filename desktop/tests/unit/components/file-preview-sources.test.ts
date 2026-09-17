import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createKnowledgeFileSource } from '../../../src/renderer/src/components/file-preview/sources'

/** 最小 window.api 桩（只提供读取接口） */
function setWindowApi(api: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).window = { api }
}

describe('知识库文件预览来源适配器', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('readText / readBytes 都走 knowledge:read-file，且知识库来源为只读', async () => {
    const readKnowledgeFile = vi.fn(async (_kbId: string, _relPath: string, as: string) =>
      as === 'text'
        ? {
            success: true,
            data: { content: '# 标题', truncated: false, ext: 'md', name: 'a.md' }
          }
        : { success: true, data: { bytes: new Uint8Array([1, 2, 3]), ext: 'md', name: 'a.md' } }
    )
    setWindowApi({ readKnowledgeFile })

    const source = createKnowledgeFileSource('kb-1', { name: 'a.md', relPath: '目录/a.md' })
    expect(source.key).toBe('目录/a.md')
    expect(source.name).toBe('a.md')
    await expect(source.readText()).resolves.toEqual({ content: '# 标题', truncated: false })
    await expect(source.readBytes?.()).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]) })
    expect(readKnowledgeFile).toHaveBeenCalledWith('kb-1', '目录/a.md', 'text')
    expect(readKnowledgeFile).toHaveBeenCalledWith('kb-1', '目录/a.md', 'bytes')
    // 知识库文件只读：不暴露保存能力（预览组件据此隐藏写入路径）
    expect(source.saveBytes).toBeUndefined()
  })

  it('读取失败时抛出异常，交给预览组件展示', async () => {
    setWindowApi({
      readKnowledgeFile: vi.fn(async () => ({ success: false, error: '文件已丢失' }))
    })
    const source = createKnowledgeFileSource('kb-1', { name: 'a.txt', relPath: 'a.txt' })
    await expect(source.readText()).rejects.toThrow('文件已丢失')
  })
})
