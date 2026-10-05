import type { BrowserWindow } from 'electron'

/** 消息流泵依赖（事件出口 + 无窗口调用方的逐段汇总回调） */
export interface StreamPumpOptions {
  /** 渲染层窗口；无窗口调用方（自动化执行）传 null，事件静默丢弃 */
  win: BrowserWindow | null
  /** 逐段汇总正式回复文本（自动化任务的输出采集） */
  onToken?: (text: string) => void
}

/** streamEvents 'messages' 投影的单条 chunk（DeepAgent v3 的结构子集） */
export interface MessageStreamChunk {
  /** 深度思考（reasoning）token 流 */
  reasoning: AsyncIterable<string>
  /** 正式回复（text）token 流 */
  text: AsyncIterable<string>
}

/**
 * 消息流泵：把 `streamEvents` 的 messages 投影泵到渲染层。
 *
 * - reasoning → `agent:stream-thinking`（整段结束补 `agent:stream-thinking-done`）；
 * - text → `agent:stream-chunk`，并同步回调 onToken（自动化任务的输出采集）。
 *
 * 返回送出的 text 片段总数（诊断日志用）。工具调用与产物流见 artifact-collector。
 */
export async function pumpMessageStream(
  messages: AsyncIterable<MessageStreamChunk>,
  options: StreamPumpOptions
): Promise<number> {
  const { win, onToken } = options
  let chunkCount = 0

  for await (const chunk of messages) {
    // 先处理 reasoning（深度思考）流
    let reasoningCount = 0
    for await (const token of chunk.reasoning) {
      reasoningCount++
      win?.webContents.send('agent:stream-thinking', token)
    }
    if (reasoningCount > 0) {
      console.log('[service] reasoning done, tokens:', reasoningCount)
      win?.webContents.send('agent:stream-thinking-done')
    }

    // 再处理 text（正式回复）流
    let textCount = 0
    for await (const text of chunk.text) {
      textCount++
      chunkCount++
      win?.webContents.send('agent:stream-chunk', text)
      onToken?.(text)
    }
    console.log(
      '[service] message chunk done, text pieces:',
      textCount,
      'reasoning pieces:',
      reasoningCount
    )
  }

  console.log('[service] all messages done, total text chunks sent:', chunkCount)
  return chunkCount
}
