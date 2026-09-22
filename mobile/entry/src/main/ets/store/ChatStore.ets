import { ChatArtifact, ChatMessage, ChatMode, ContentBlock, ResultFail, Workspace } from '../common/types/Models'
import { ServiceFactory } from '../services/ServiceFactory'
import { ChatSendRequest, ChatStreamHandlers } from '../services/contracts/ChatService'
import { attachArtifactsToMessages } from '../common/utils/ArtifactGroups'
import { buildArtifactDownloadUrl, buildBundleUrl, MarkdownImageContext } from '../common/utils/MarkdownArtifacts'
import { markdownToBlocks } from '../common/utils/MarkdownBlocks'
import { Constants } from '../common/constants/Constants'

/** 移动端平台标识:服务端据此渲染提示词 */
const PLATFORM_MOBILE: string = 'mobile'

/** 当前会话(全局单例) */
@ObservedV2
export class ChatStore {
  @Trace mode: ChatMode = 'cloud'
  @Trace messages: ChatMessage[] = []
  @Trace selectedWorkspace: Workspace = { id: 'task', name: '任务' }
  @Trace sending: boolean = false
  /** 当前会话 id(首轮由服务端下发) */
  @Trace threadId: string = ''
  /** 当前选择的专家(可选) */
  @Trace expertId: string = ''
  @Trace expertName: string = ''
  /** 会话产物(去重,供打包与历史挂载) */
  @Trace threadArtifacts: ChatArtifact[] = []
  private seq: number = 0

  reset(): void {
    this.messages = []
    this.sending = false
    this.threadId = ''
    this.threadArtifacts = []
  }

  private apiBase(): string {
    return Constants.BASE_URL + '/api'
  }

  /** 产物预览/下载地址(disposition=attachment 触发下载) */
  artifactUrlFor(artifact: ChatArtifact, disposition: string = 'attachment'): string {
    return buildArtifactDownloadUrl(this.apiBase(), this.threadId, artifact.path, disposition)
  }

  /** 交付物打包地址(scope=turn 本轮 / scope=thread 整个会话) */
  bundleUrlFor(scope: string, turn: string): string {
    return buildBundleUrl(this.apiBase(), this.threadId, scope, turn === '' ? undefined : turn)
  }

  /** 图片解析上下文:basePath 取会话内最近的文章产物 */
  private imageContext(): MarkdownImageContext {
    const paths: string[] = []
    let basePath: string = ''
    for (let i = 0; i < this.threadArtifacts.length; i++) {
      const item: ChatArtifact = this.threadArtifacts[i]
      paths.push(item.path)
      if (item.path.endsWith('.md')) {
        basePath = item.path
      }
    }
    const context: MarkdownImageContext = {
      threadId: this.threadId,
      basePath: basePath,
      artifactPaths: paths,
      apiBaseUrl: this.apiBase()
    }
    return context
  }

  /** 登记产物:加入会话产物清单并挂到当前助手消息 */
  private registerArtifact(assistantId: string, artifact: ChatArtifact): void {
    let known: boolean = false
    for (let i = 0; i < this.threadArtifacts.length; i++) {
      if (this.threadArtifacts[i].path === artifact.path) {
        known = true
        break
      }
    }
    this.threadArtifacts = known
      ? this.threadArtifacts.map((item: ChatArtifact): ChatArtifact => item.path === artifact.path ? artifact : item)
      : [...this.threadArtifacts, artifact]

    this.messages = this.messages.map((msg: ChatMessage): ChatMessage => {
      if (msg.id !== assistantId) {
        return msg
      }
      const current: ChatArtifact[] = msg.artifacts ?? []
      const exists: boolean = current.some((item: ChatArtifact): boolean => item.path === artifact.path)
      const next: ChatArtifact[] = exists
        ? current.map((item: ChatArtifact): ChatArtifact => item.path === artifact.path ? artifact : item)
        : [...current, artifact]
      const updated: ChatMessage = {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        blocks: msg.blocks,
        status: msg.status,
        createdAt: msg.createdAt,
        artifacts: next
      }
      return updated
    })
  }

  /** 更新助手消息正文与内容块 */
  private updateAssistant(assistantId: string, markdown: string, done: boolean): void {
    const blocks: ContentBlock[] = done ? markdownToBlocks(markdown, this.imageContext()) : []
    this.messages = this.messages.map((msg: ChatMessage): ChatMessage => {
      if (msg.id !== assistantId) {
        return msg
      }
      const updated: ChatMessage = {
        id: msg.id,
        role: msg.role,
        content: markdown,
        blocks: blocks.length > 0 ? blocks : msg.blocks,
        status: done ? 'done' : msg.status,
        createdAt: msg.createdAt,
        artifacts: msg.artifacts
      }
      return updated
    })
  }

  /** 发送消息:先入 user 气泡与助手占位,再走流式对话 */
  async send(text: string): Promise<void> {
    const trimmed: string = text.trim()
    if (trimmed === '' || this.sending) {
      return
    }
    this.sending = true
    const userMsg: ChatMessage = {
      id: `u${++this.seq}`,
      role: 'user',
      content: trimmed,
      status: 'done',
      createdAt: Date.now()
    }
    const assistantMsg: ChatMessage = {
      id: `a${++this.seq}`,
      role: 'assistant',
      content: '',
      status: 'thinking',
      createdAt: Date.now()
    }
    this.messages = [...this.messages, userMsg, assistantMsg]

    const request: ChatSendRequest = {
      message: trimmed,
      platform: PLATFORM_MOBILE,
      threadId: this.threadId === '' ? undefined : this.threadId,
      expertId: this.expertId === '' ? undefined : this.expertId,
      expertName: this.expertName === '' ? undefined : this.expertName
    }

    let markdown: string = ''
    let failure: string = ''
    const handlers: ChatStreamHandlers = {
      onTokenText: (piece: string) => {
        markdown += piece
        this.updateAssistant(assistantMsg.id, markdown, false)
      },
      onArtifact: (artifact: ChatArtifact) => {
        this.registerArtifact(assistantMsg.id, artifact)
      },
      onArtifactUpdated: (artifact: ChatArtifact) => {
        this.registerArtifact(assistantMsg.id, artifact)
      },
      onError: (message: string) => {
        failure = message
      }
    }

    const service = ServiceFactory.getChat()
    const streamed = await service.stream(request, handlers)

    if (streamed.ok) {
      this.threadId = streamed.value
      this.updateAssistant(assistantMsg.id, markdown, true)
      // 流中漏掉的产物兜底拉取一次(老数据/事件丢失)
      const listed = await service.listArtifacts(this.threadId)
      if (listed.ok) {
        const items: Array<ChatArtifact> = listed.value
        for (let i = 0; i < items.length; i++) {
          this.registerArtifact(assistantMsg.id, items[i])
        }
      }
    } else {
      const streamFail = streamed as ResultFail
      failure = failure === '' ? streamFail.message : failure
      if (markdown !== '') {
        this.updateAssistant(assistantMsg.id, markdown, true)
      } else {
        this.updateAssistant(assistantMsg.id, failure, true)
      }
    }
    this.sending = false
  }

  /**
   * 历史回显:拉取会话产物并按轮挂到对应助手消息。
   * (轮次数与助手消息数一致时精确挂载,否则挂到最后一条)
   */
  async loadThread(threadId: string): Promise<void> {
    this.threadId = threadId
    const listed = await ServiceFactory.getChat().listArtifacts(threadId)
    if (!listed.ok) {
      return
    }
    this.threadArtifacts = listed.value
    const carriers: ChatMessage[] = attachArtifactsToMessages(this.messages, listed.value)
    this.messages = carriers
  }
}

export const chatStore = new ChatStore()
