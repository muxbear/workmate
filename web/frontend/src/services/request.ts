import axios, { type AxiosInstance, type InternalAxiosRequestConfig, type AxiosError } from 'axios'
import type { ApiResponse } from '@/types/api'

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

// 响应拦截器
instance.interceptors.response.use(
  (response) => {
    const data = response.data as ApiResponse
    if (data.code !== 0) {
      return Promise.reject(new ApiError(data.code, data.message))
    }
    return response
  },
  async (error: AxiosError<ApiResponse>) => {
    const isRefreshRequest = error.config?.url?.includes('/auth/refresh') ?? false
    if (error.response?.status === 401 && error.config && !isRefreshRequest) {
      if (!getRefreshTokenValue()) {
        clearTokensFromStorage()
        window.location.href = '/login'
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
        error.config.headers.Authorization = `Bearer ${getAccessToken()}`
        return instance.request(error.config)
      } catch {
        clearTokensFromStorage()
        window.location.href = '/login'
      } finally {
        refreshPromise = null
      }
    }
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
