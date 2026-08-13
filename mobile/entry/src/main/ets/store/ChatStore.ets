import { ChatMessage, ChatMode, ContentBlock, ResultFail, Workspace } from '../common/types/Models'
import { ServiceFactory } from '../services/ServiceFactory'

/** 当前会话(全局单例) */
@ObservedV2
export class ChatStore {
  @Trace mode: ChatMode = 'cloud'
  @Trace messages: ChatMessage[] = []
  @Trace selectedWorkspace: Workspace = { id: 'task', name: '任务' }
  @Trace sending: boolean = false
  private seq: number = 0

  reset(): void {
    this.messages = []
    this.sending = false
  }

  /** 发送消息:先入 user 气泡,再入 thinking 助手,完成后转 done */
  async send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.sending) {
      return
    }
    this.sending = true
    const userMsg: ChatMessage = {
      id: `u${++this.seq}`,
      role: 'user',
      content: trimmed,
      status: 'done',
      createdAt: Date.now(),
    }
    const assistantMsg: ChatMessage = {
      id: `a${++this.seq}`,
      role: 'assistant',
      content: '',
      status: 'thinking',
      createdAt: Date.now(),
    }
    this.messages = [...this.messages, userMsg, assistantMsg]

    const r = await ServiceFactory.getChat().send({
      mode: this.mode,
      workspaceId: this.selectedWorkspace.id,
      message: trimmed,
      history: [],
    })

    if (r.ok) {
      const replyBlocks: ContentBlock[] = r.value.reply
      this.messages = this.messages.map((m: ChatMessage): ChatMessage => {
        if (m.id !== assistantMsg.id) {
          return m
        }
        const updated: ChatMessage = {
          id: m.id,
          role: m.role,
          content: m.content,
          status: 'done',
          createdAt: m.createdAt,
          blocks: replyBlocks,
        }
        return updated
      })
    } else {
      const fail = r as ResultFail
      const errMsg = fail.message
      this.messages = this.messages.map((m: ChatMessage): ChatMessage => {
        if (m.id !== assistantMsg.id) {
          return m
        }
        const updated: ChatMessage = {
          id: m.id,
          role: m.role,
          content: m.content,
          status: 'done',
          createdAt: m.createdAt,
          blocks: [{ type: 'text', content: errMsg }],
        }
        return updated
      })
    }
    this.sending = false
  }
}

export const chatStore = new ChatStore()
