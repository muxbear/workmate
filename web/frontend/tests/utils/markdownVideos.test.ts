import { describe, expect, it } from 'vitest'
import {
  extractVideoSources,
  replaceVideoSrc,
  resolveVideoArtifacts,
} from '@/utils/markdownVideos'
import type { MarkdownImageContext } from '@/utils/markdownArtifacts'

const THREAD = 't-video-1'
const CONTEXT: MarkdownImageContext = {
  threadId: THREAD,
  basePath: `/artifacts/${THREAD}/turn-1/视频标题.md`,
  artifactPaths: [`/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`],
}

const TAG = '<video controls preload="none" src="视频标题/成片-1.mp4"></video>'

describe('markdownVideos（成片相对路径解析）', () => {
  it('提取 <video src> 的相对路径，跳过协议地址并去重', () => {
    const content = [
      TAG,
      TAG,
      '<video src="https://cdn.example.com/a.mp4"></video>',
      '<video src="data:video/mp4;base64,AAA"></video>',
      "<video src='视频标题/成片-2.mp4'></video>",
    ].join('\n')

    expect(extractVideoSources(content)).toEqual(['视频标题/成片-1.mp4', '视频标题/成片-2.mp4'])
  })

  it('命中产物清单时解析为虚拟路径，未命中返回空', () => {
    const resolved = resolveVideoArtifacts(TAG, CONTEXT)
    expect(resolved['视频标题/成片-1.mp4']).toEqual({
      threadId: THREAD,
      path: `/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`,
    })

    // 不在产物清单里的相对路径不做替换（避免把普通链接当成产物）
    const missed = resolveVideoArtifacts('<video src="其它/成片-9.mp4"></video>', CONTEXT)
    expect(missed).toEqual({})
  })

  it('已就绪时替换为 blob 地址，加载中摘掉 src，外部地址保持原样', () => {
    const ready = replaceVideoSrc(TAG, { '视频标题/成片-1.mp4': 'blob:ready-1' })
    expect(ready).toContain('src="blob:ready-1"')
    expect(ready).toContain('controls')

    const pending = replaceVideoSrc(TAG, {}, { '视频标题/成片-1.mp4': true })
    expect(pending).not.toContain('<video controls preload="none" src=')
    expect(pending).toContain('data-artifact-src="视频标题/成片-1.mp4"')

    const external = '<video src="https://cdn.example.com/a.mp4"></video>'
    expect(replaceVideoSrc(external, {})).toBe(external)
  })

  it('无 src 或空内容时原样返回', () => {
    expect(replaceVideoSrc('', {})).toBe('')
    expect(replaceVideoSrc('<video controls></video>', {})).toBe('<video controls></video>')
  })

  it('支持 <video> 内嵌 <source src> 的写法（模型常用写法）', () => {
    const html =
      '<video controls width="640" preload="metadata">' +
      '<source src="视频标题/成片-1.mp4" type="video/mp4">' +
      '你的浏览器不支持 HTML5 视频播放。' +
      '</video>'

    expect(extractVideoSources(html)).toEqual(['视频标题/成片-1.mp4'])
    const out = replaceVideoSrc(html, { '视频标题/成片-1.mp4': 'blob:web/src' })
    expect(out).toContain('src="blob:web/src"')
    expect(out).not.toContain('src="视频标题/成片-1.mp4"')
    expect(out).toContain('type="video/mp4"')
  })
})
