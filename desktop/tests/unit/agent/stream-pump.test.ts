import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  pumpMessageStream,
  type MessageStreamChunk
} from '../../../src/main/agent/stream-pump'

function makeWin(): BrowserWindow {
  return { webContents: { send: vi.fn() } } as unknown as BrowserWindow
}

async function* streamOf(...items: string[]): AsyncIterable<string> {
  for (const item of items) yield item
}

function chunk(reasoning: string[], text: string[]): MessageStreamChunk {
  return { reasoning: streamOf(...reasoning), text: streamOf(...text) }
}

async function* messagesOf(...chunks: MessageStreamChunk[]): AsyncIterable<MessageStreamChunk> {
  for (const item of chunks) yield item
}

describe('pumpMessageStream', () => {
  it('reasoning 推 stream-thinking（结束补 thinking-done）；text 推 stream-chunk 并回调 onToken', async () => {
    const win = makeWin()
    const tokens: string[] = []
    const count = await pumpMessageStream(messagesOf(chunk(['想', '考'], ['你', '好'])), {
      win,
      onToken: (text) => tokens.push(text)
    })

    const send = win.webContents.send as ReturnType<typeof vi.fn>
    expect(
      send.mock.calls.filter((c) => c[0] === 'agent:stream-thinking').map((c) => c[1])
    ).toEqual(['想', '考'])
    expect(send.mock.calls.some((c) => c[0] === 'agent:stream-thinking-done')).toBe(true)
    expect(
      send.mock.calls.filter((c) => c[0] === 'agent:stream-chunk').map((c) => c[1])
    ).toEqual(['你', '好'])
    expect(tokens).toEqual(['你', '好'])
    expect(count).toBe(2)
  })

  it('无 reasoning 的 chunk 不推送 thinking-done', async () => {
    const win = makeWin()
    await pumpMessageStream(messagesOf(chunk([], ['正文'])), { win })
    const send = win.webContents.send as ReturnType<typeof vi.fn>
    expect(send.mock.calls.some((c) => c[0] === 'agent:stream-thinking-done')).toBe(false)
  })

  it('win 为 null（自动化路径）时静默且不抛，onToken 照常汇总', async () => {
    const tokens: string[] = []
    const count = await pumpMessageStream(messagesOf(chunk(['t'], ['a', 'b'])), {
      win: null,
      onToken: (text) => tokens.push(text)
    })
    expect(tokens).toEqual(['a', 'b'])
    expect(count).toBe(2)
  })
})
