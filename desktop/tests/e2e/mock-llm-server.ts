/**
 * Mock LLM 服务（E2E 用，OpenAI Chat Completions 兼容）。
 *
 * 背景：e2e 的 agent 链路需要模型端点。此前以「占位凭据 + 真实网络拒绝」兜底，
 * 失败要走 LangChain 重试退避（10-30s），期间发送按钮常驻停止态，
 * 「连发多条消息建多个会话」类用例会被拖入竞态（delete-task / remove-workspace / new-task-file）。
 * 本 mock 让模型调用**立即成功返回**，这类用例即可完全绿化。
 *
 * 实现：
 * - POST /chat/completions（含 /v1 前缀别名）：按请求体 stream 字段返回 SSE 流式或一次性 JSON；
 * - 端口随机（listen 0），多测试文件并行互不冲突；
 * - 回复文案可经 setMockLlmReply 定制（默认「模拟回复：已收到您的消息。」），
 *   summarizeTitle / polish 等链路复用同一端点。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'

let server: Server | null = null
/** 固定回复文案；null = 回显模式（把请求里最后一条 user 消息片段带入回复） */
let reply: string | null = null
/** 收到的 chat/completions 请求数（断言用） */
let requestCount = 0

/** 设置固定回复文案（缺省为回显模式：回复携带请求中 user 消息片段） */
export function setMockLlmReply(text: string): void {
  reply = text
}

/** 恢复回显模式 */
export function resetMockLlmReply(): void {
  reply = null
}

/** 读取累计请求数（断言用） */
export function getMockLlmStats(): { requests: number } {
  return { requests: requestCount }
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chatChunkBase(): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model'
  }
}

function handleChat(req: IncomingMessage, res: ServerResponse): void {
  requestCount += 1
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    let body: { stream?: boolean; messages?: Array<{ role?: string; content?: unknown }> } = {}
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      // 非法 JSON 按非流式处理
    }
    // 回显模式（默认）：回复携带请求中最后一条 user 消息的片段 ——
    // 「附件/引用内容是否真的进了模型请求」这类断言由此获得来自请求本身的证据。
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
    const userText =
      typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    const snippet = userText.replace(/\s+/g, ' ').slice(0, 100)
    const replyText = reply ?? `模拟回复：已收到您的内容（${snippet}）`

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // 角色帧 → 内容分 3 段（短暂间隔，保持"流式"语义）→ 结束帧 → [DONE]
      res.write(
        sseChunk({
          ...chatChunkBase(),
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        })
      )
      const parts = [
        replyText.slice(0, 6),
        replyText.slice(6, 12),
        replyText.slice(12)
      ].filter(Boolean)
      let i = 0
      const timer = setInterval(() => {
        if (i < parts.length) {
          res.write(
            sseChunk({
              ...chatChunkBase(),
              choices: [
                { index: 0, delta: { content: parts[i] }, finish_reason: null }
              ]
            })
          )
          i += 1
          return
        }
        clearInterval(timer)
        res.write(
          sseChunk({
            ...chatChunkBase(),
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }, 10)
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
}

/** 启动 mock LLM，返回其 base URL（随机端口，形如 http://127.0.0.1:xxxxx；重复调用幂等） */
let currentUrl = ''

export function startMockLlmServer(): Promise<string> {
  if (server && currentUrl) return Promise.resolve(currentUrl)
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method === 'POST' && /^\/(v1\/)?chat\/completions$/.test(url)) {
        handleChat(req, res)
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') {
        reject(new Error('mock llm: 无法获取监听端口'))
        return
      }
      requestCount = 0
      currentUrl = `http://127.0.0.1:${address.port}`
      resolve(currentUrl)
    })
  })
}

export function stopMockLlmServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    const s = server
    server = null
    s.closeAllConnections?.()
    s.close(() => resolve())
  })
}
