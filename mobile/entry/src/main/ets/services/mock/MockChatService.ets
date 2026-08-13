import { ContentBlock, Result } from '../../common/types/Models'
import { delay } from '../../common/utils/Async'
import { ChatReply, ChatRequest, ChatService } from '../contracts/ChatService'

/** 云端模式示例回复(设计稿"WorkBuddy 云端架构") */
const CLOUD_REPLY: ContentBlock[] = [
  {
    type: 'text',
    content: 'WorkBuddy 云端是一套**运行在隔离沙盒中的自主 AI 代理系统**,核心思路是把"大模型推理"和"真实计算机操作能力"解耦——大脑在云端推理,手脚在沙盒里执行。下面拆解它的工作原理。',
  },
  { type: 'heading', content: '整体架构' },
  {
    type: 'table',
    headers: ['层级', '作用'],
    rows: [
      ['接入层', '接收用户指令、文件、上下文'],
      ['推理层', 'LLM 规划任务、决定调用哪些工具'],
      ['执行层', '在沙盒里真正干活:点击、输入、截图'],
      ['反馈层', '把执行结果截图/输出传回给 LLM'],
    ],
  },
]

/** 桌面模式示例回复(设计稿"运行前提条件") */
const DESKTOP_REPLY: ContentBlock[] = [
  { type: 'text', content: '指定的对应电脑的环境,无需重新复配置。' },
  { type: 'heading', content: '运行前提条件' },
  {
    type: 'list',
    items: [
      '电脑必须**开机、联网、WorkBuddy 客户端运行中**(如果电脑休眠或断网,远程指令无法执行)',
      '手机和电脑需登录**同一微信账号**',
      '支持的 IM 平台包括:微信、企业微信、QQ、钉钉、飞书、元宝派等',
    ],
  },
  { type: 'heading', content: '另一种模式:云端沙箱' },
  {
    type: 'text',
    content: '除了连接电脑的"本机远程模式",WorkBuddy App 还提供**云端沙箱模式**——不需要电脑开机,任务直接在腾讯云沙箱中执行。不过这种模式下无法访问你电脑上的本地文件,适合通勤、差旅等没带电脑的场景。',
  },
]

export class MockChatService implements ChatService {
  async send(req: ChatRequest): Promise<Result<ChatReply>> {
    await delay(1800)   // 与设计稿 thinking 1.8s 一致
    const reply = req.mode === 'desktop' ? DESKTOP_REPLY : CLOUD_REPLY
    const value: ChatReply = { reply: reply }
    return { ok: true, value: value } as Result<ChatReply>
  }
}
