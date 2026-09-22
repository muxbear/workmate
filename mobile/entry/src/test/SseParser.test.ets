import { describe, it, expect } from '@ohos/hypium'
import { parseSseChunk, SseEvent, SseParseResult } from '../main/ets/common/utils/SseParser'

export default function sseParserTest() {
  describe('SseParser', () => {
    it('parseSseChunk_singleEvent', 0, () => {
      const r: SseParseResult = parseSseChunk('', 'event: token\ndata: {"content":"a"}\n\n')
      expect(r.events.length).assertEqual(1)
      const e: SseEvent = r.events[0]
      expect(e.event).assertEqual('token')
      expect(e.data).assertEqual('{"content":"a"}')
      expect(r.rest).assertEqual('')
    })

    it('parseSseChunk_multipleEvents', 0, () => {
      const chunk: string = 'event: artifact\ndata: {}\n\nevent: done\ndata: {}\n\n'
      const r: SseParseResult = parseSseChunk('', chunk)
      expect(r.events.length).assertEqual(2)
      expect(r.events[1].event).assertEqual('done')
    })

    it('parseSseChunk_splitAcrossChunks', 0, () => {
      const first: SseParseResult = parseSseChunk('', 'event: token\ndata: {"a"')
      expect(first.events.length).assertEqual(0)
      expect(first.rest).assertContain('event: token')
      const second: SseParseResult = parseSseChunk(first.rest, ':1}\n\n')
      expect(second.events.length).assertEqual(1)
      expect(second.events[0].data).assertEqual('{"a":1}')
      expect(second.rest).assertEqual('')
    })

    it('parseSseChunk_crlfAndBlankLines', 0, () => {
      const chunk: string = '\r\nevent: token\r\ndata: x\r\n\r\n'
      const r: SseParseResult = parseSseChunk('', chunk)
      expect(r.events.length).assertEqual(1)
      expect(r.events[0].data).assertEqual('x')
    })

    it('parseSseChunk_defaultsEventName', 0, () => {
      const r: SseParseResult = parseSseChunk('', 'data: only-data\n\n')
      expect(r.events.length).assertEqual(1)
      expect(r.events[0].event).assertEqual('message')
      expect(r.events[0].data).assertEqual('only-data')
    })
  })
}
