import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { useArtifactVideos, type MarkdownVideoContext } from '@/composables/useArtifactVideos'

const { fetchArtifactObjectUrl } = vi.hoisted(() => ({ fetchArtifactObjectUrl: vi.fn() }))
vi.mock('@/services/artifactApi', () => ({ fetchArtifactObjectUrl }))

const TAG = '<video controls src="视频标题/成片-1.mp4"></video>'

function makeContext(threadId: string, size = 0): MarkdownVideoContext {
  const path = `/artifacts/${threadId}/turn-1/视频标题/成片-1.mp4`
  return {
    threadId,
    basePath: `/artifacts/${threadId}/turn-1/视频标题.md`,
    artifactPaths: [path],
    artifactSizes: size > 0 ? { [path]: size } : {},
  }
}

describe('useArtifactVideos（成片带鉴权加载）', () => {
  beforeEach(() => {
    fetchArtifactObjectUrl.mockReset()
    URL.revokeObjectURL = vi.fn()
  })

  it('命中产物时带鉴权拉取字节并替换为 blob 地址', async () => {
    fetchArtifactObjectUrl.mockResolvedValue('blob:video-1')
    const scope = effectScope()
    const videos = scope.run(() =>
      useArtifactVideos(
        () => TAG,
        () => makeContext('t-video-load'),
      ),
    )!

    await flushPromises()

    expect(fetchArtifactObjectUrl).toHaveBeenCalledWith(
      't-video-load',
      '/artifacts/t-video-load/turn-1/视频标题/成片-1.mp4',
    )
    expect(videos.sources.value['视频标题/成片-1.mp4']).toBe('blob:video-1')
    expect(videos.render(TAG)).toContain('src="blob:video-1"')
    scope.stop()
  })

  it('超过内联上限的成片不拉取，摘掉 src 并标记 oversized', async () => {
    const scope = effectScope()
    const videos = scope.run(() =>
      useArtifactVideos(
        () => TAG,
        () => makeContext('t-video-big', 200 * 1024 * 1024),
        { maxInlineBytes: 1024 },
      ),
    )!

    await flushPromises()

    expect(fetchArtifactObjectUrl).not.toHaveBeenCalled()
    expect(videos.oversized.value['视频标题/成片-1.mp4']).toBe(true)
    const html = videos.render(TAG)
    // 不能留下真正的 src（否则浏览器会去请求不存在的相对地址）
    expect(html).not.toMatch(/\ssrc="/)
    expect(html).toContain('data-artifact-src="视频标题/成片-1.mp4"')
    scope.stop()
  })

  it('未命中产物清单时不触发拉取', async () => {
    const scope = effectScope()
    const videos = scope.run(() =>
      useArtifactVideos(
        () => '<video src="其它/成片-9.mp4"></video>',
        () => makeContext('t-video-miss'),
      ),
    )!

    await flushPromises()

    expect(fetchArtifactObjectUrl).not.toHaveBeenCalled()
    expect(videos.sources.value).toEqual({})
    scope.stop()
  })

  it('非视频内容不受影响（无 <video> 时不拉取）', async () => {
    const scope = effectScope()
    const videos = scope.run(() =>
      useArtifactVideos(
        () => '# 标题\n\n正文内容',
        () => makeContext('t-video-none'),
      ),
    )!

    await flushPromises()

    expect(fetchArtifactObjectUrl).not.toHaveBeenCalled()
    expect(videos.render('<p>正文</p>')).toBe('<p>正文</p>')
    scope.stop()
  })
})
