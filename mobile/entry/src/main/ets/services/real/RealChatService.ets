import { http } from '@kit.NetworkKit'
import { util } from '@kit.ArkTS'
import { ChatArtifact, Result, ResultFail } from '../../common/types/Models'
import { parseSseChunk, SseEvent, SseParseResult } from '../../common/utils/SseParser'
import { Constants } from '../../common/constants/Constants'
import { HttpClient } from '../http/HttpClient'
import {
  ChatApiReply,
  ChatSendReply,
  ChatSendRequest,
  ChatService,
  ChatStreamHandlers
} from '../contracts/ChatService'

/** SSE 事件体:{"event":"artifact","data":{...}} */
interface SsePayload {
  event: string
  data: Object
}

/** 请求体(显式接口,满足 arkts-no-untyped-obj-literals) */
interface ChatRequestBody {
  message: string
  platform: string
  thread_id?: string
  expert_id?: string
  expert_name?: string
  model_id?: string
  provider_id?: string
}

export class RealChatService implements ChatService {
  private buildBody(req: ChatSendRequest): ChatRequestBody {
    const body: ChatRequestBody = {
      message: req.message,
      platform: req.platform
    }
    if (req.threadId !== undefined && req.threadId !== '') {
      body.thread_id = req.threadId
    }
    if (req.expertId !== undefined && req.expertId !== '') {
      body.expert_id = req.expertId
    }
    if (req.expertName !== undefined && req.expertName !== '') {
      body.expert_name = req.expertName
    }
    if (req.modelId !== undefined && req.modelId !== '') {
      body.model_id = req.modelId
    }
    if (req.providerId !== undefined && req.providerId !== '') {
      body.provider_id = req.providerId
    }
    return body
  }

  async send(req: ChatSendRequest): Promise<Result<ChatSendReply>> {
    const r = await HttpClient.getInstance().post<ChatApiReply>('/api/chat', this.buildBody(req))
    if (!r.ok) {
      return r
    }
    const value: ChatSendReply = { threadId: r.value.thread_id, markdown: r.value.response }
    return { ok: true, value: value } as Result<ChatSendReply>
  }

  /**
   * 流式对话:POST /api/chat/stream(SSE)。
   *
   * 说明:使用 http 模块的 dataReceive 事件累积分片,由 parseSseChunk 做跨分片解析;
   * token 事件拼接为完整 Markdown 返回,artifact / artifact_updated 事件回调上层登记。
   */
  async stream(req: ChatSendRequest, handlers: ChatStreamHandlers): Promise<Result<string>> {
    const httpRequest = http.createHttp()
    const body: ChatRequestBody = this.buildBody(req)
    const header: Record<string, string> = { 'Content-Type': 'application/json' }
    const token: string = HttpClient.getInstance().getToken()
    if (token !== '') {
      header['Authorization'] = `Bearer ${token}`
    }

    let buffer: string = ''
    let markdown: string = ''
    let threadId: string = req.threadId ?? ''
    let failure: string = ''

    httpRequest.on('dataReceive', (data: ArrayBuffer) => {
      const text: string = new util.TextDecoder('utf-8').decodeWithStream(new Uint8Array(data))
      const parsed: SseParseResult = parseSseChunk(buffer, text)
      buffer = parsed.rest
      for (let i = 0; i < parsed.events.length; i++) {
        const item: SseEvent = parsed.events[i]
        if (item.data === '') {
          continue
        }
        let payload: SsePayload
        try {
          payload = JSON.parse(item.data) as SsePayload
        } catch (err) {
          continue
        }
        if (payload.event === 'token') {
          const piece: TokenData = payload.data as TokenData
          if (piece.content !== undefined) {
            markdown += piece.content
            if (handlers.onTokenText !== undefined) {
              handlers.onTokenText(piece.content)
            }
          }
        } else if (payload.event === 'artifact') {
          if (handlers.onArtifact !== undefined) {
            handlers.onArtifact(payload.data as ChatArtifact)
          }
        } else if (payload.event === 'artifact_updated') {
          if (handlers.onArtifactUpdated !== undefined) {
            handlers.onArtifactUpdated(payload.data as ChatArtifact)
          }
        } else if (payload.event === 'selection') {
          const selection: SelectionData = payload.data as SelectionData
          if (selection.delivery_dir !== undefined) {
            threadId = req.threadId ?? threadId
          }
        } else if (payload.event === 'done') {
          const done: DoneData = payload.data as DoneData
          if (done.thread_id !== undefined) {
            threadId = done.thread_id
          }
        } else if (payload.event === 'error') {
          const errorData: ErrorData = payload.data as ErrorData
          failure = errorData.message ?? '服务处理请求时发生错误'
        }
      }
    })

    try {
      await httpRequest.request(Constants.BASE_URL + '/api/chat/stream', {
        method: http.RequestMethod.POST,
        header: header,
        extraData: JSON.stringify(body),
        connectTimeout: Constants.TIMEOUT_MS,
        readTimeout: Constants.STREAM_TIMEOUT_MS
      })
    } catch (err) {
      return { ok: false, code: -1, message: '网络异常,请稍后重试' } as ResultFail
    } finally {
      httpRequest.destroy()
    }

    if (failure !== '') {
      if (handlers.onError !== undefined) {
        handlers.onError(failure)
      }
      return { ok: false, code: -1, message: failure } as ResultFail
    }
    if (threadId === '') {
      return { ok: false, code: -1, message: '会话标识缺失,请重试' } as ResultFail
    }
    return { ok: true, value: threadId } as Result<string>
  }

  async listArtifacts(threadId: string): Promise<Result<Array<ChatArtifact>>> {
    return HttpClient.getInstance().get<Array<ChatArtifact>>(
      `/api/chat/artifacts/${threadId}`
    )
  }
}

/** token 事件数据 */
interface TokenData {
  content?: string
}

/** selection 事件数据(仅取用需要的字段) */
interface SelectionData {
  delivery_dir?: string
  platform?: string
  expert_name?: string
}

/** done 事件数据 */
interface DoneData {
  thread_id?: string
}

/** error 事件数据 */
interface ErrorData {
  message?: string
}
