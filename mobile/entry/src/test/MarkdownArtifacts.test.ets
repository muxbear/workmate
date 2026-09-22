import { describe, it, expect } from '@ohos/hypium'
import {
  buildArtifactDownloadUrl,
  buildBundleUrl,
  buildImageSrcMap,
  extractImageSources,
  normalizeImagePath,
  resolveImagePath,
  resolveImageSrc,
  MarkdownImageContext
} from '../main/ets/common/utils/MarkdownArtifacts'

const BASE: string = 'https://api.example.com/api'

export default function markdownArtifactsTest() {
  describe('MarkdownArtifacts', () => {
    it('normalizeImagePath_decodesAndTrims', 0, () => {
      expect(normalizeImagePath('文章/figure-1.png?v=1')).assertEqual('文章/figure-1.png')
      expect(normalizeImagePath('文章/figure-1.png#top')).assertEqual('文章/figure-1.png')
      expect(normalizeImagePath('%E6%96%87%E7%AB%A0/f.png')).assertEqual('文章/f.png')
    })

    it('resolveImagePath_relativeAndAbsolute', 0, () => {
      expect(resolveImagePath('/artifacts/t1/turn-1/文章.md', '文章/figure-1.png'))
        .assertEqual('/artifacts/t1/turn-1/文章/figure-1.png')
      expect(resolveImagePath('/artifacts/t1/turn-1/a/b.md', '../img/x.png'))
        .assertEqual('/artifacts/t1/turn-1/img/x.png')
      expect(resolveImagePath(undefined, '/artifacts/t1/turn-1/x.png'))
        .assertEqual('/artifacts/t1/turn-1/x.png')
    })

    it('resolveImagePath_rejectsSchemeAndEscape', 0, () => {
      expect(resolveImagePath('/artifacts/t1/turn-1/文章.md', 'https://x/a.png')).assertEqual('')
      expect(resolveImagePath('文章.md', '../../escape.png')).assertEqual('')
    })

    it('buildArtifactDownloadUrl_encodesPath', 0, () => {
      const url: string = buildArtifactDownloadUrl(BASE, 't1', '/artifacts/t1/turn-1/文章/f1.png', 'inline')
      expect(url).assertContain('/chat/artifacts/t1/download')
      expect(url).assertContain('disposition=inline')
      expect(url).assertContain(encodeURIComponent('/artifacts/t1/turn-1/文章/f1.png'))
    })

    it('buildBundleUrl_turnAndThread', 0, () => {
      expect(buildBundleUrl(BASE, 't1', 'turn', 'turn-2'))
        .assertEqual(BASE + '/chat/artifacts/t1/bundle.zip?scope=turn&turn=turn-2')
      expect(buildBundleUrl(BASE, 't1', 'thread'))
        .assertEqual(BASE + '/chat/artifacts/t1/bundle.zip?scope=thread')
    })

    it('resolveImageSrc_hitAndMiss', 0, () => {
      const context: MarkdownImageContext = {
        threadId: 't1',
        basePath: '/artifacts/t1/turn-1/文章.md',
        artifactPaths: ['/artifacts/t1/turn-1/文章/figure-1.png'],
        apiBaseUrl: BASE
      }
      const hit: string = resolveImageSrc('文章/figure-1.png', context)
      expect(hit).assertContain('/chat/artifacts/t1/download')

      const missed: MarkdownImageContext = {
        threadId: 't1',
        basePath: '/artifacts/t1/turn-1/文章.md',
        artifactPaths: ['/artifacts/t1/turn-1/文章/other.png'],
        apiBaseUrl: BASE
      }
      expect(resolveImageSrc('文章/missing.png', missed)).assertEqual('文章/missing.png')

      const noThread: MarkdownImageContext = {}
      expect(resolveImageSrc('文章/figure-1.png', noThread)).assertEqual('文章/figure-1.png')
    })

    it('resolveImageSrc_keepsSchemeUrls', 0, () => {
      const context: MarkdownImageContext = { threadId: 't1', apiBaseUrl: BASE }
      expect(resolveImageSrc('https://cdn.example.com/a.png', context))
        .assertEqual('https://cdn.example.com/a.png')
    })

    it('extractImageSources_dedupesInOrder', 0, () => {
      const sources: Array<string> = extractImageSources('![](a/1.png) 文本 ![](a/1.png) ![](b/2.png)')
      expect(sources.length).assertEqual(2)
      expect(sources[0]).assertEqual('a/1.png')
      expect(sources[1]).assertEqual('b/2.png')
    })

    it('buildImageSrcMap_onlyChangedEntries', 0, () => {
      const mapContext: MarkdownImageContext = {
        threadId: 't1',
        basePath: '/artifacts/t1/turn-1/文章.md',
        artifactPaths: ['/artifacts/t1/turn-1/文章/f1.png'],
        apiBaseUrl: BASE
      }
      const map: Map<string, string> = buildImageSrcMap('![](文章/f1.png) ![](https://x/a.png)', mapContext)
      expect(map.size).assertEqual(1)
      expect(map.get('文章/f1.png') !== undefined).assertTrue()
      expect(map.get('https://x/a.png') === undefined).assertTrue()
    })
  })
}