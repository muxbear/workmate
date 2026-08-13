import { ChatMode, ContentBlock, Result } from '../../common/types/Models'

export interface ChatRequest {
  mode: ChatMode
  workspaceId?: string
  message: string
  history: string[]   // 最近对话原文,用于上下文(本期仅透传)
}

export interface ChatReply {
  reply: ContentBlock[]
}

/** AI 对话服务契约 */
export interface ChatService {
  send(req: ChatRequest): Promise<Result<ChatReply>>
}
