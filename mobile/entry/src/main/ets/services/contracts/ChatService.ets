import { ChatArtifact, Result } from '../../common/types/Models'

/** 对话请求(与后端 /api/chat(*)、/api/chat/stream 请求体对齐) */
export interface ChatSendRequest {
  threadId?: string
  message: string
  /** 客户端平台:移动端固定传 mobile,服务端据此渲染提示词 */
  platform: string
  expertId?: string
  expertName?: string
  modelId?: string
  providerId?: string
}

/** 非流式回复 */
export interface ChatSendReply {
  threadId: string
  markdown: string
}

/** 流式(SSE)回调:token/artifact/artifact_updated/error */
export interface ChatStreamHandlers {
  onTokenText?: (text: string) => void
  onArtifact?: (artifact: ChatArtifact) => void
  onArtifactUpdated?: (artifact: ChatArtifact) => void
  onError?: (message: string) => void
}

/** 后端非流式响应体(/api/chat 的 data) */
export interface ChatApiReply {
  thread_id: string
  response: string
  duration_ms?: number
}

/** AI 对话服务契约 */
export interface ChatService {
  /** 非流式对话(SSE 不可用时的兜底) */
  send(req: ChatSendRequest): Promise<Result<ChatSendReply>>
  /** 流式对话,返回 threadId */
  stream(req: ChatSendRequest, handlers: ChatStreamHandlers): Promise<Result<string>>
  /** 拉取会话产物(历史回显/流结束兜底) */
  listArtifacts(threadId: string): Promise<Result<Array<ChatArtifact>>>
}
