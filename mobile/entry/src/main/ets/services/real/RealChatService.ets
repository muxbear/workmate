import { ContentBlock, Result } from '../../common/types/Models'
import { HttpClient } from '../http/HttpClient'
import { ChatReply, ChatRequest, ChatService } from '../contracts/ChatService'

export class RealChatService implements ChatService {
  async send(req: ChatRequest): Promise<Result<ChatReply>> {
    const r = await HttpClient.getInstance().post<ChatReply>('/api/v1/chat', req)
    return r
  }
}
