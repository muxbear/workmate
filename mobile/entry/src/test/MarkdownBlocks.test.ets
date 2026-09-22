import { describe, it, expect } from '@ohos/hypium'
import { markdownToBlocks } from '../main/ets/common/utils/MarkdownBlocks'
import { MarkdownImageContext } from '../main/ets/common/utils/MarkdownArtifacts'
import { ContentBlock, HeadingBlock, ImageBlock, ListBlock, TableBlock, TextBlock } from '../main/ets/common/types/Models'

const CONTEXT: MarkdownImageContext = {
  threadId: 't1',
  basePath: '/artifacts/t1/turn-1/文章标题.md',
  artifactPaths: ['/artifacts/t1/turn-1/文章标题/figure-1.png'],
  apiBaseUrl: 'https://api.example.com/api'
}

export default function markdownBlocksTest() {
  describe('MarkdownBlocks', () => {
    it('markdownToBlocks_headingAndParagraph', 0, () => {
      const blocks: Array<ContentBlock> = markdownToBlocks('# 标题\n\n正文段落', CONTEXT)
      expect(blocks.length).assertEqual(2)
      expect(blocks[0].type).assertEqual('heading')
      const heading: HeadingBlock = blocks[0] as HeadingBlock
      expect(heading.content).assertEqual('标题')
      expect(blocks[1].type).assertEqual('text')
      const text: TextBlock = blocks[1] as TextBlock
      expect(text.content).assertEqual('正文段落')
    })

    it('markdownToBlocks_list', 0, () => {
      const blocks: Array<ContentBlock> = markdownToBlocks('- 一\n- 二\n1. 三', CONTEXT)
      expect(blocks.length).assertEqual(1)
      const list: ListBlock = blocks[0] as ListBlock
      expect(list.items.length).assertEqual(3)
      expect(list.items[2]).assertEqual('三')
    })

    it('markdownToBlocks_table', 0, () => {
      const md: string = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |'
      const blocks: Array<ContentBlock> = markdownToBlocks(md, CONTEXT)
      expect(blocks.length).assertEqual(1)
      const table: TableBlock = blocks[0] as TableBlock
      expect(table.headers.length).assertEqual(2)
      expect(table.rows.length).assertEqual(1)
      expect(table.rows[0][1]).assertEqual('2')
    })

    it('markdownToBlocks_imageResolved', 0, () => {
      const blocks: Array<ContentBlock> = markdownToBlocks('![](文章标题/figure-1.png)', CONTEXT)
      expect(blocks.length).assertEqual(1)
      expect(blocks[0].type).assertEqual('image')
      const image: ImageBlock = blocks[0] as ImageBlock
      expect(image.src).assertContain('/chat/artifacts/t1/download')
    })

    it('markdownToBlocks_imageKeepsOrder', 0, () => {
      const blocks: Array<ContentBlock> = markdownToBlocks('前文\n![](文章标题/figure-1.png)\n后文', CONTEXT)
      expect(blocks.length).assertEqual(3)
      expect(blocks[0].type).assertEqual('text')
      expect(blocks[1].type).assertEqual('image')
      expect(blocks[2].type).assertEqual('text')
      const tail: TextBlock = blocks[2] as TextBlock
      expect(tail.content).assertEqual('后文')
    })

    it('markdownToBlocks_emptyAndPlain', 0, () => {
      expect(markdownToBlocks('', CONTEXT).length).assertEqual(0)
      expect(markdownToBlocks('   ', CONTEXT).length).assertEqual(0)
      const plain: Array<ContentBlock> = markdownToBlocks('**加粗**文本', CONTEXT)
      expect(plain.length).assertEqual(1)
      const text: TextBlock = plain[0] as TextBlock
      expect(text.content).assertEqual('**加粗**文本')
    })
  })
}
