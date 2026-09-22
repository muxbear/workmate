/**
 * SSE(Server-Sent Events)分片解析(纯函数,便于单测)。
 *
 * 后端 /api/chat/stream 每条消息形如:
 *   data: {"event":"token","data":{...}}\n\n
 * 网络分片可能把一条消息切开,因此解析需要携带"未完成尾巴"。
 */

/** 单条 SSE 事件(原始 event/data 字符串) */
export interface SseEvent {
  event: string
  data: string
}

/** 解析结果:已完整的事件 + 剩余未完成片段 */
export interface SseParseResult {
  events: Array<SseEvent>
  rest: string
}

/**
 * 解析一段 SSE 文本。
 *
 * @param buffer 上次解析剩余的未完成片段(首次调用传空串)
 * @param chunk 本次收到的文本分片
 */
export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const text: string = buffer + chunk
  const events: Array<SseEvent> = []
  // 以空行分隔事件块(兼容 \r\n\r\n 与 \n\n)
  const normalized: string = text.replace(/\r\n/g, '\n')
  const parts: Array<string> = normalized.split('\n\n')
  const rest: string = parts.pop() ?? ''

  for (let i = 0; i < parts.length; i++) {
    const block: string = parts[i]
    if (block.trim() === '') {
      continue
    }
    let eventName: string = 'message'
    let data: string = ''
    const rows: Array<string> = block.split('\n')
    for (let j = 0; j < rows.length; j++) {
      const row: string = rows[j]
      if (row.startsWith('event:')) {
        eventName = row.substring(6).trim()
      } else if (row.startsWith('data:')) {
        const piece: string = row.substring(5).trim()
        data = data === '' ? piece : data + '\n' + piece
      }
    }
    events.push({ event: eventName, data: data } as SseEvent)
  }
  return { events: events, rest: rest } as SseParseResult
}