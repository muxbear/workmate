import { describe, it, expect } from '@ohos/hypium'
import { parseBold, InlinePiece } from '../main/ets/common/utils/MarkdownParser'

export default function markdownParserTest() {
  describe('MarkdownParser', () => {
    it('parseBold_simple', 0, () => {
      const r = parseBold('**粗体**')
      expect(r.length).assertEqual(1)
      expect(r[0].bold).assertTrue()
      expect(r[0].text).assertEqual('粗体')
    })
    it('parseBold_mixed', 0, () => {
      const r = parseBold('开头**中间**结尾')
      expect(r.length).assertEqual(3)
      const head: InlinePiece = { bold: false, text: '开头' }
      const mid: InlinePiece = { bold: true, text: '中间' }
      const tail: InlinePiece = { bold: false, text: '结尾' }
      expect(r[0]).assertDeepEquals(head)
      expect(r[1]).assertDeepEquals(mid)
      expect(r[2]).assertDeepEquals(tail)
    })
    it('parseBold_noBold', 0, () => {
      const r = parseBold('普通文本')
      expect(r.length).assertEqual(1)
      expect(r[0].bold).assertFalse()
    })
    it('parseBold_unclosed', 0, () => {
      const r = parseBold('未闭合的**标记')
      expect(r.length).assertEqual(1)
      expect(r[0].text).assertEqual('未闭合的**标记')
      expect(r[0].bold).assertFalse()
    })
    it('parseBold_empty', 0, () => {
      const r = parseBold('')
      expect(r.length).assertEqual(0)
    })
    it('parseBold_consecutive', 0, () => {
      const r = parseBold('a**b**c**d**e')
      expect(r.length).assertEqual(5)
      expect(r[1].bold).assertTrue()
      expect(r[3].bold).assertTrue()
    })
  })
}
