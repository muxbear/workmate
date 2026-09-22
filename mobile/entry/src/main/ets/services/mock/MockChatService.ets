import { ChatArtifact, Result } from '../../common/types/Models'
import { delay } from '../../common/utils/Async'
import { ChatSendReply, ChatSendRequest, ChatService, ChatStreamHandlers } from '../contracts/ChatService'

/** 设计稿示例回复(Markdown 形态,与后端返回一致) */
const CLOUD_MARKDOWN: string = [
  'WorkBuddy 云端是一套**运行在隔离沙盒中的自主 AI 代理系统**,核心思路是把"大模型推理"和"真实计算机操作能力"解耦。',
  '',
  '## 整体架构',
  '',
  '| 层级 | 作用 |',
  '| --- | --- |',
  '| 接入层 | 接收用户指令、文件、上下文 |',
  '| 推理层 | LLM 规划任务、决定调用哪些工具 |',
  '| 执行层 | 在沙盒里真正干活:点击、输入、截图 |',
  '| 反馈层 | 把执行结果截图/输出传回给 LLM |'
].join('\n')

const DESKTOP_MARKDOWN: string = [
  '指定电脑的环境,无需重新配置。',
  '',
  '## 运行前提条件',
  '',
  '- 电脑必须**开机、联网、客户端运行中**',
  '- 手机和电脑需登录**同一账号**',
  '',
  '## 另一种模式:云端沙箱',
  '',
  '不需要电脑开机,任务直接在云沙箱中执行。'
].join('\n')

export class MockChatService implements ChatService {
  async send(req: ChatSendRequest): Promise<Result<ChatSendReply>> {
    await delay(1200)
    const value: ChatSendReply = {
      threadId: req.threadId ?? 'mock-thread',
      markdown: req.expertId === 'doc' ? DESKTOP_MARKDOWN : CLOUD_MARKDOWN
    }
    return { ok: true, value: value } as Result<ChatSendReply>
  }

  async stream(req: ChatSendRequest, handlers: ChatStreamHandlers): Promise<Result<string>> {
    const r = await this.send(req)
    if (!r.ok) {
      return r
    }
    if (handlers.onTokenText !== undefined) {
      handlers.onTokenText(r.value.markdown)
    }
    return { ok: true, value: r.value.threadId } as Result<string>
  }

  async listArtifacts(threadId: string): Promise<Result<Array<ChatArtifact>>> {
    const empty: Array<ChatArtifact> = []
    return { ok: true, value: empty } as Result<Array<ChatArtifact>>
  }
}
