import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { PENDING_IMAGE_PLACEHOLDER, useArtifactImages } from '@/composables/useArtifactImages'
import type { MarkdownImageContext } from '@/utils/markdownArtifacts'

const { fetchArtifactObjectUrl } = vi.hoisted(() => ({ fetchArtifactObjectUrl: vi.fn() }))
vi.mock('@/services/artifactApi', () => ({ fetchArtifactObjectUrl }))

function makeContext(threadId: string): MarkdownImageContext {
  return {
    threadId,
    basePath: `/artifacts/${threadId}/turn-1/文章.md`,
    artifactPaths: [`/artifacts/${threadId}/turn-1/文章/figure-1.png`],
  }
}

describe('useArtifactImages（配图带鉴权加载）', () => {
  beforeEach(() => {
    fetchArtifactObjectUrl.mockReset()
    URL.revokeObjectURL = vi.fn()
  })

  it('命中产物时用鉴权拉取的 blob 地址渲染，外部图片不触发拉取', async () => {
    fetchArtifactObjectUrl.mockResolvedValue('blob:loaded-1')
    const scope = effectScope()
    const images = scope.run(() =>
      useArtifactImages(
        () => '![](文章/figure-1.png) ![](https://cdn.example.com/a.png)',
        () => makeContext('t-load-1'),
      ),
    )!

    await flushPromises()

    expect(fetchArtifactObjectUrl).toHaveBeenCalledTimes(1)
    expect(fetchArtifactObjectUrl).toHaveBeenCalledWith(
      't-load-1',
      '/artifacts/t-load-1/turn-1/文章/figure-1.png',
    )
    expect(images.sources.value['文章/figure-1.png']).toBe('blob:loaded-1')
    expect(images.renderSrc('https://cdn.example.com/a.png', {})).toBe('https://cdn.example.com/a.png')
    scope.stop()
  })

  it('加载中先用占位图；失败后回退产物地址（暴露可见的失败）', async () => {
    let releaseTask: (value: string | null) => void = () => {}
    fetchArtifactObjectUrl.mockReturnValue(
      new Promise<string | null>((resolve) => {
        releaseTask = resolve
      }),
    )
    const scope = effectScope()
    const images = scope.run(() =>
      useArtifactImages(() => '![](文章/figure-1.png)', () => makeContext('t-fail-1')),
    )!
    const fallback = { '文章/figure-1.png': '/api/chat/artifacts/t-fail-1/download' }

    await nextTick()
    expect(images.renderSrc('文章/figure-1.png', fallback)).toBe(PENDING_IMAGE_PLACEHOLDER)

    releaseTask(null)
    await flushPromises()
    expect(images.renderSrc('文章/figure-1.png', fallback)).toBe(fallback['文章/figure-1.png'])
    scope.stop()
  })

  it('同一会话同一路径跨组件共享缓存，最后一个使用者卸载才释放', async () => {
    fetchArtifactObjectUrl.mockResolvedValue('blob:shared-1')
    const scopeA = effectScope()
    scopeA.run(() =>
      useArtifactImages(() => '![](文章/figure-1.png)', () => makeContext('t-share-1')),
    )
    await flushPromises()

    const scopeB = effectScope()
    const second = scopeB.run(() =>
      useArtifactImages(() => '![](文章/figure-1.png)', () => makeContext('t-share-1')),
    )!
    await flushPromises()

    expect(fetchArtifactObjectUrl).toHaveBeenCalledTimes(1)
    expect(second.sources.value['文章/figure-1.png']).toBe('blob:shared-1')

    scopeA.stop()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    scopeB.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shared-1')
  })
})
