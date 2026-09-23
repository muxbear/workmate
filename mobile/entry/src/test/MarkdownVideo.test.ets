import { describe, it, expect } from '@ohos/hypium'
import {
  extractVideoSources,
  resolveVideoSrc,
  videoBlockCaption,
  MarkdownImageContext
} from '../main/ets/common/utils/MarkdownArtifacts'
import { ContentBlock } from '../main/ets/common/types/Models'
import { markdownToBlocks } from '../main/ets/common/utils/MarkdownBlocks'

const THREAD: string = 't-video-1'
const BASE: string = 'https://api.example.com/api'
const CONTEXT: MarkdownImageContext = {
  threadId: THREAD,
  basePath: `/artifacts/${THREAD}/turn-1/视频标题.md`,
  artifactPaths: [`/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`],
  apiBaseUrl: BASE
}

export default function markdownVideoTest() {
  describe('MarkdownVideo', () => {
    it('extractVideoSources_relativeOnly', 0, () => {
      const markdown: string = '<video controls src="视频标题/成片-1.mp4"></video>'
        + '<video src="https://cdn.example.com/a.mp4"></video>'
        + '<video src="data:video/mp4;base64,AAA"></video>'
        + "<video src='视频标题/成片-2.mp4'></video>"
      const found: Array<string> = extractVideoSources(markdown)
      expect(found.length).assertEqual(2)
      expect(found[0]).assertEqual('视频标题/成片-1.mp4')
      expect(found[1]).assertEqual('视频标题/成片-2.mp4')
    })

    it('extractVideoSources_nestedSourceTag', 0, () => {
      // 模型常用写法: <video> 内嵌 <source src>,旧实现只认 video 自身的 src 属性
      const markdown: string = '<video controls width="640" preload="metadata">\n'
        + '  <source src="视频标题/成片-1.mp4" type="video/mp4">\n'
        + '  你的浏览器不支持 HTML5 视频播放。\n'
        + '</video>'
      const found: Array<string> = extractVideoSources(markdown)
      expect(found.length).assertEqual(1)
      expect(found[0]).assertEqual('视频标题/成片-1.mp4')
    })

    it('resolveVideoSrc_toArtifactUrl', 0, () => {
      const url: string = resolveVideoSrc('视频标题/成片-1.mp4', CONTEXT)
      expect(url).assertContain('/chat/artifacts/t-video-1/download')
      expect(url).assertContain(encodeURIComponent(`/artifacts/${THREAD}/turn-1/视频标题/成片-1.mp4`))
    })

    it('resolveVideoSrc_withoutThreadKeepsRaw', 0, () => {
      const url: string = resolveVideoSrc('视频标题/成片-1.mp4', { threadId: '' })
      expect(url).assertEqual('视频标题/成片-1.mp4')
    })

    it('videoBlockCaption_stripsTags', 0, () => {
      const block: string = '<video controls><source src="a.mp4" type="video/mp4">你的浏览器不支持 HTML5 视频播放。</video>'
      expect(videoBlockCaption(block)).assertEqual('你的浏览器不支持 HTML5 视频播放。')
      expect(videoBlockCaption('<video controls src="a.mp4"></video>')).assertEqual('')
    })

    it('markdownToBlocks_emitsVideoBlock', 0, () => {
      const markdown: string = '# 标题\n\n'
        + '<video controls preload="none" src="视频标题/成片-1.mp4"></video>\n\n'
        + '说明文字'
      const blocks: Array<ContentBlock> = markdownToBlocks(markdown, CONTEXT)
      let videoIndex: number = -1
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'video') {
          videoIndex = i
        }
      }
      expect(videoIndex >= 0).assertTrue()
      const videoBlock = blocks[videoIndex] as ContentBlock & { src: string }
      expect(videoBlock.src).assertContain('/chat/artifacts/t-video-1/download')
    })

    it('markdownToBlocks_nestedSourceVideo', 0, () => {
      const markdown: string = '三、成片\n\n'
        + '<video controls width="640">\n'
        + '  <source src="视频标题/成片-1.mp4" type="video/mp4">\n'
        + '  你的浏览器不支持 HTML5 视频播放。\n'
        + '</video>'
      const blocks: Array<ContentBlock> = markdownToBlocks(markdown, CONTEXT)
      let found: boolean = false
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'video') {
          found = true
        }
      }
      expect(found).assertTrue()
    })

    it('markdownToBlocks_plainTextUnaffected', 0, () => {
      const blocks: Array<ContentBlock> = markdownToBlocks('普通段落,没有视频。', CONTEXT)
      expect(blocks.length).assertEqual(1)
      expect(blocks[0].type).assertEqual('text')
    })
  })
}
