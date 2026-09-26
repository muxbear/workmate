import axios, { type AxiosInstance, type InternalAxiosRequestConfig, type AxiosError } from 'axios'
import { ElMessage } from 'element-plus'
import type { ApiResponse } from '@/types/api'

// 给请求配置加一个开关。用模块增强而不是自造 config 类型：调用方仍然写
// `instance.get(url, { notify: true })`，类型检查直接认。
declare module 'axios' {
  export interface AxiosRequestConfig {
    /**
     * 置 ``true`` 时由拦截器弹一次全局错误提示。
     *
     * **为什么是 opt-in 而不是默认开启**：全站有 90 处调用点自己
     * `ElMessage.error(...)`，而它们包住的接口调用大多在 **store 方法**里
     * （如 `agentStore.addConfig`），store 又被多处共用——没有按调用点精确
     * opt-out 的办法。默认开启会让这 90 处全部双重报错（两条内容还不一样的提示
     * 叠在一起），而先做 store 层管道改造才能把它们逐一标静默。
     *
     * 所以本轮：默认与既有行为一致（不弹），**需要全局提示的调用点显式打开**——
     * 主要是那些此前会静默失败、用户完全看不到的路径。把默认翻成开启是管道改造
     * 之后的一行改动，已记入遗留。
     */
    notify?: boolean
  }
}

// ---- Token 存储（与 auth store 共享 key，避免循环依赖） ----

const TOKEN_STORAGE_KEY = 'auth_tokens'

function getAccessToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (raw) return JSON.parse(raw).accessToken ?? null
  } catch {
    // ignore
  }
  return null
}

/**
 * 取当前 access token —— 供 EventSource 使用。
 *
 * 浏览器的 EventSource 不能自定义请求头，因此通知流与知识库索引进度流都通过
 * 查询参数携带 token（后端对应接口用 decode_token 校验）。
 */
export function getStreamToken(): string | null {
  return getAccessToken()
}

function getRefreshTokenValue(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (raw) return JSON.parse(raw).refreshToken ?? null
  } catch {
    // ignore
  }
  return null
}

// ---- Axios 实例 ----

const instance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000,
  headers: {},
})

// 请求拦截器：从存储读取并注入 token
instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Token 刷新去重锁（统一走 auth store，刷新后同步用户信息并重载权限）
let refreshPromise: Promise<void> | null = null

/**
 * 把任意错误转成**可直接展示**的中文文案。
 *
 * 这是全站唯一一处把错误翻成人话的地方（拦截器与 `readApiError` 共用）。存在的
 * 理由很具体：HTTP 状态错误的 `Error.message` 是 axios 造的
 * ``"Request failed with status code 413"``，而后端真正想说的话在
 * ``response.data.detail`` 上（FastAPI 的 ``HTTPException(detail=...)``，本来就是
 * 中文）。不读它，用户看到的就只是一串状态码。
 */
export function extractErrorMessage(error: unknown): string {
  const shape = error as {
    response?: { data?: { detail?: unknown; message?: unknown } }
    code?: string
    message?: string
  }

  const body = shape?.response?.data
  const detail = body?.detail ?? body?.message
  if (typeof detail === 'string' && detail) return detail
  // 422 校验错误的 detail 是数组（每条含 msg），取第一条——否则又退回状态码文案
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: unknown }
    if (typeof first?.msg === 'string' && first.msg) return first.msg
  }

  // 响应体里的 code != 0 由拦截器包成 ApiError，它的 message 就是后端文案
  if (error instanceof ApiError && error.message) return error.message

  if (shape?.code === 'ECONNABORTED' || shape?.code === 'ETIMEDOUT') {
    return '请求超时，请稍后重试'
  }
  if (shape?.code === 'ERR_NETWORK') return '网络异常，请检查网络后重试'

  if (shape?.message) return shape.message
  return '操作失败'
}

/** 按调用点的 ``notify`` 开关决定是否弹一次全局错误提示。 */
function notifyError(error: unknown, notify: boolean | undefined): void {
  if (notify !== true) return
  ElMessage.error(extractErrorMessage(error))
}

// 响应拦截器
instance.interceptors.response.use(
  (response) => {
    const data = response.data as ApiResponse
    if (data.code !== 0) {
      const error = new ApiError(data.code, data.message)
      notifyError(error, response.config?.notify)
      return Promise.reject(error)
    }
    return response
  },
  async (error: AxiosError<ApiResponse>) => {
    const config = error.config as InternalAxiosRequestConfig | undefined
    const isRefreshRequest = config?.url?.includes('/auth/refresh') ?? false

    if (error.response?.status === 401 && config && !isRefreshRequest) {
      if (!getRefreshTokenValue()) {
        clearTokensFromStorage()
        window.location.href = '/login'
        // 不弹提示：正在跳登录页，弹了也看不到
        return Promise.reject(error)
      }

      try {
        if (!refreshPromise) {
          refreshPromise = (async () => {
            const { useAuthStore } = await import('@/stores/auth')
            const authStore = useAuthStore()
            await authStore.refreshAccessToken()
          })()
        }
        await refreshPromise
        config.headers.Authorization = `Bearer ${getAccessToken()}`
        return instance.request(config)
      } catch {
        clearTokensFromStorage()
        window.location.href = '/login'
        return Promise.reject(error)
      } finally {
        refreshPromise = null
      }
    }

    notifyError(error, config?.notify)
    return Promise.reject(error)
  },
)

function clearTokensFromStorage() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY)
}

export { getAccessToken, getRefreshTokenValue, clearTokensFromStorage }

export class ApiError extends Error {
  constructor(
    public code: string | number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export default instance

function chatAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const token = getAccessToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

import type {
  AgentStartData,
  AgentEndData,
  ToolStartData,
  ToolEndData,
  ChatInputPart,
  ChatSelection,
  SelectionEcho,
  ChatArtifact,
} from '@/types/chat'

/** 流式结束回调携带的元信息 */
export interface DoneInfo {
  durationMs?: number
}

export interface StreamCallbacks {
  onToken: (agentName: string, content: string) => void
  onReasoning: (agentName: string, content: string) => void
  onAgentStart: (data: AgentStartData) => void
  onAgentEnd: (data: AgentEndData) => void
  onToolStart: (data: ToolStartData) => void
  onToolOutput: (callId: string, content: string) => void
  onToolEnd: (data: ToolEndData) => void
  onThreadId: (threadId: string) => void
  onSelection?: (data: SelectionEcho) => void
  onArtifact?: (artifact: ChatArtifact) => void
  onArtifactUpdated?: (artifact: ChatArtifact) => void
  onDone: (info?: DoneInfo) => void
  onError: (message: string) => void
}

type SsePayload = {
  event: string
  data: Record<string, unknown>
}

function parseSseDataLine(line: string, callbacks: StreamCallbacks): void {
  if (!line.startsWith('data: ')) return
  try {
    const payload = JSON.parse(line.slice(6)) as SsePayload
    const { event, data } = payload

    switch (event) {
      case 'token':
        callbacks.onToken(data.agent_name as string, data.content as string)
        break
      case 'reasoning':
        callbacks.onReasoning(data.agent_name as string, data.content as string)
        break
      case 'agent_start':
        callbacks.onAgentStart(data as unknown as AgentStartData)
        break
      case 'agent_end':
        callbacks.onAgentEnd(data as unknown as AgentEndData)
        break
      case 'tool_start':
        callbacks.onToolStart(data as unknown as ToolStartData)
        break
      case 'tool_output':
        callbacks.onToolOutput(data.call_id as string, data.content as string)
        break
      case 'tool_end':
        callbacks.onToolEnd(data as unknown as ToolEndData)
        break
      case 'error':
        callbacks.onError(data.message as string)
        break
      case 'artifact':
        callbacks.onArtifact?.(data as unknown as ChatArtifact)
        break
      case 'artifact_updated':
        callbacks.onArtifactUpdated?.(data as unknown as ChatArtifact)
        break
      case 'selection':
        callbacks.onSelection?.(data as unknown as SelectionEcho)
        break
      case 'done':
        callbacks.onThreadId(data.thread_id as string)
        callbacks.onDone({ durationMs: data.duration_ms as number | undefined })
        break
    }
  } catch {
    // skip malformed SSE line
  }
}

/**
 * SSE 流式请求
 */
export async function sendStreamRequest(
  message: string,
  options: {
    threadId?: string | null
    callbacks: StreamCallbacks
    attachmentIds?: string[]
    parts?: ChatInputPart[]
    selection?: ChatSelection
    signal?: AbortSignal
  },
): Promise<void> {
  const { threadId, callbacks, attachmentIds, parts, selection, signal } = options

  const body: Record<string, unknown> = { message }
  if (threadId) {
    body.thread_id = threadId
  }
  if (attachmentIds && attachmentIds.length > 0) {
    body.attachment_ids = attachmentIds
  }
  if (parts && parts.length > 0) {
    body.parts = parts.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'file', attachment_id: part.attachmentId, filename: part.filename },
    )
  }
  if (selection) {
    if (selection.expertId) body.expert_id = selection.expertId
    if (selection.expertName) body.expert_name = selection.expertName
    if (selection.skillIds.length > 0) body.skill_ids = selection.skillIds
    if (selection.kbIds.length > 0) body.kb_ids = selection.kbIds
    if (selection.mode !== 'default') body.mode = selection.mode
    if (selection.model) body.model = selection.model
    if (selection.modelId) body.model_id = selection.modelId
    if (selection.providerId) body.provider_id = selection.providerId
    if (selection.webSearch) body.web_search = true
    if (selection.workspaceId) body.workspace_id = selection.workspaceId
    // 显式下发（false 也下发），服务端据此收紧沙箱策略
    body.allow_network = selection.allowNetwork
    body.allow_shell = selection.allowShell
  }

  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(`${baseURL}/chat/stream`, {
    method: 'POST',
    headers: chatAuthHeaders(),
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    callbacks.onError('ReadableStream not supported')
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let doneReceived = false

  // Wrap onDone so we can track whether the stream completed cleanly
  const originalOnDone = callbacks.onDone
  callbacks.onDone = (info?: DoneInfo) => {
    doneReceived = true
    originalOnDone(info)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        parseSseDataLine(line, callbacks)
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        parseSseDataLine(line, callbacks)
      }
    }
  } catch (err) {
    callbacks.onError(err instanceof Error ? err.message : String(err))
  } finally {
    // Safety fallback: if the backend closes the connection without a done event,
    // ensure the frontend doesn't stay in loading state forever
    if (!doneReceived) {
      callbacks.onDone()
    }
  }
}

/**
 * 普通对话（非流式）— 降级方案
 * POST /api/chat → { response, thread_id }
 */
export async function sendChatRequest(
  message: string,
  threadId?: string | null,
): Promise<{ response: string; threadId: string }> {
  const body: { message: string; thread_id?: string } = { message }
  if (threadId) {
    body.thread_id = threadId
  }

  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(`${baseURL}/chat`, {
    method: 'POST',
    headers: chatAuthHeaders(),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  const data = (await response.json()) as { response: string; thread_id: string }
  return {
    response: data.response,
    threadId: data.thread_id,
  }
}
/** 会话产物列表接口 */
export async function fetchThreadArtifacts(threadId: string): Promise<ChatArtifact[]> {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(baseURL + '/chat/artifacts/' + encodeURIComponent(threadId), {
    headers: chatAuthHeaders(),
  })
  if (!response.ok) return []
  const payload = (await response.json()) as { data?: ChatArtifact[] }
  return payload.data ?? []
}

/** 产物下载 / 预览地址（disposition=inline 用于预览，attachment 用于下载） */
export function artifactDownloadUrl(
  threadId: string,
  path: string,
  disposition: 'inline' | 'attachment' = 'attachment',
): string {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  return (
    baseURL +
    '/chat/artifacts/' +
    encodeURIComponent(threadId) +
    '/download?disposition=' +
    disposition +
    '&path=' +
    encodeURIComponent(path)
  )
}

/** AI 改写润色：把输入文本改写为更清晰的任务描述 */
export async function polishText(text: string): Promise<string> {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const response = await fetch(baseURL + '/chat/polish', {
    method: 'POST',
    headers: chatAuthHeaders(),
    body: JSON.stringify({ text }),
  })
  if (!response.ok) {
    throw new Error('HTTP ' + response.status)
  }
  const payload = (await response.json()) as { data?: { text?: string } }
  return payload.data?.text ?? ' '
}


/** 交付物打包下载地址：scope=turn 本轮 / scope=thread 整个会话 */
export function artifactBundleUrl(
  threadId: string,
  scope: 'turn' | 'thread' = 'turn',
  turn?: string,
): string {
  const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
  const params = new URLSearchParams({ scope })
  if (scope === 'turn' && turn) params.set('turn', turn)
  return (
    baseURL +
    '/chat/artifacts/' +
    encodeURIComponent(threadId) +
    '/bundle.zip?' +
    params.toString()
  )
}
