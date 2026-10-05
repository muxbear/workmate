import type { BrowserWindow } from 'electron'
import type { BaseMessage, MessageContent } from '@langchain/core/messages'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage
} from '@langchain/core/messages'
import type { DeepAgent } from 'deepagents'
import type { BackendKind } from './AgentBuilder'
import type { RawConversationMessage } from './ConversationStore'
import type { DocArtifactFile } from '../../shared/contracts'
import { ArtifactCollector, type AgentRunHandle } from './artifact-collector'
import { pumpMessageStream } from './stream-pump'

/** 会话绑定的工作空间信息（写入 checkpoint metadata 持久化） */
export interface WorkspaceBinding {
  id: string
  name: string
  dir?: string
}

/** 图运行上下文（thread 与用户隔离；workspace_dir 供 backend 工厂按会话解析根目录） */
export interface AgentRunConfig {
  thread_id: string
  user_id: string
  /** 工作空间目录（进 configurable，LocalShellBackend 根目录） */
  workspace_dir?: string
  /** 工作空间绑定（进 metadata，checkpoint 持久化后用于会话分组） */
  workspace?: WorkspaceBinding | null
  /** 自定义模型 id（进 configurable，模型覆盖中间件读取；缺省用默认模型） */
  modelOverride?: string
  /** 主智能体后端：filesystem=仅文件读写；shell=文件读写 + 本地 shell（缺省走 shell） */
  backendKind?: BackendKind
}

/** 会话消息转 LangChain 消息（带 DB/checkpoint id，addMessages reducer 按 id 去重防重复累积） */
export function toLangChainMessages(messages: RawConversationMessage[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'user':
        // rawContent（文件附件块数组）优先透传，保序进图；旧数据回退折叠字符串
        // （rawContent 类型为 unknown，运行时是 checkpoint content 原样保留的块数组，断言 MessageContent）
        return new HumanMessage({
          id: m.id,
          content: (m.rawContent ?? m.content) as MessageContent
        })
      case 'assistant':
        return new AIMessage({ id: m.id, content: m.content })
      case 'tool':
        return new ToolMessage({
          id: m.id,
          content: m.content,
          tool_call_id: m.toolCallId ?? m.id,
          ...(m.toolName ? { name: m.toolName } : {})
        })
      case 'system':
        return new SystemMessage({ id: m.id, content: m.content })
    }
  })
}

/**
 * 构造"重新生成"的图输入：把最后一条 user 消息之后的所有消息（旧 AI 回复 + 期间 tool 消息）
 * 转为 RemoveMessage 删除命令，messages 通道 reducer 删除旧回复后，图从 checkpoint 状态
 * 继续运行生成新回复（不新增 user 消息，无重复）。
 *
 * 边界：尾部无消息（上次发送失败、checkpoint 停在 user 消息）时返回最后一条 user 消息本身
 * （同 id 经 reducer 去重为 no-op，保证图执行）
 */
export function buildRegenerateInput(history: RawConversationMessage[]): BaseMessage[] {
  const lastUserIdx = history.map((m) => m.role).lastIndexOf('user')
  // 无 user 消息（异常状态）不删除任何内容
  if (lastUserIdx === -1) return []
  const tail = history.slice(lastUserIdx + 1)
  const removes = tail.map((m) => new RemoveMessage({ id: m.id })).filter((m) => m.id)
  if (removes.length === 0) {
    // 尾部无消息（上次发送失败、checkpoint 停在 user 消息）时返回最后一条 user 消息本身
    // （同 id 经 reducer 去重为 no-op，保证图执行）
    return toLangChainMessages([history[lastUserIdx]])
  }
  return removes
}

/**
 * 发送消息运行上下文（Context Object）。
 * 历史是 7 个位置参数（messages/win/agent/config/signal/onArtifacts/onToken），
 * 调用方（agent:send、自动化执行、测试）极易因顺序写错静默传参错位，收敛为具名对象。
 */
export interface SendMessageContext {
  messages: BaseMessage[]
  /** 渲染层窗口；无窗口调用方（自动化执行）传 null，事件静默丢弃 */
  win: BrowserWindow | null
  agent: DeepAgent
  config: AgentRunConfig
  signal?: AbortSignal
  /** 流结束回调：持久化产物清单，供历史回显恢复文件链接 */
  onArtifacts?: (artifacts: DocArtifactFile[]) => void
  /** 无窗口调用方（自动化执行）用：逐段汇总正式回复文本 */
  onToken?: (text: string) => void
}

/**
 * 运行一次发送：`agent.streamEvents` 起两条并发流，跑完补发完成信号。
 *
 * - 消息流（reasoning / text token）→ `stream-pump.pumpMessageStream`；
 * - 工具调用与文档产物流（含嵌套子智能体）→ `artifact-collector.walkTools`；
 * - 结束后发 `agent:stream-done`，并把产物清单经 `onArtifacts` 交回调用方持久化。
 */
export async function invokeSendMessage(ctx: SendMessageContext): Promise<void> {
  const { messages, win, agent, config, signal } = ctx
  console.log('[service] invokeSendMessage called, messages count:', messages.length)
  console.log('[service] signal aborted?:', signal?.aborted)

  const events = await agent.streamEvents(
    { messages },
    {
      version: 'v3',
      signal,
      configurable: {
        thread_id: config.thread_id,
        user_id: config.user_id,
        // workspace_dir 进入 configurable：backend 工厂运行时据此创建 LocalShellBackend
        ...(config.workspace_dir ? { workspace_dir: config.workspace_dir } : {}),
        // model_override 进入 configurable：模型覆盖中间件运行期替换模型（只传 id，凭据不进 checkpoint）
        ...(config.modelOverride ? { model_override: config.modelOverride } : {}),
        // backend_kind 进入 configurable：backend 工厂运行时据此创建 FilesystemBackend / LocalShellBackend
        ...(config.backendKind ? { backend_kind: config.backendKind } : {})
      },
      // workspace 绑定写入 checkpoint metadata（langgraph 持久化，会话列表据此分组）
      ...(config.workspace ? { metadata: { workspace: config.workspace } } : {})
    }
  )
  console.log(
    '[service] streamEvents returned, type:',
    typeof events,
    'has messages:',
    'messages' in events
  )

  // ── 文档产物流（并发于消息流，含嵌套子智能体的工具调用）──
  const collector = new ArtifactCollector({
    win,
    workspaceId: config.workspace?.id ?? null,
    workspaceDir: config.workspace_dir ?? config.workspace?.dir,
    signal
  })

  const messagesTask = pumpMessageStream(events.messages, { win, onToken: ctx.onToken })
  const toolTask = collector.walkTools(events as unknown as AgentRunHandle)

  await Promise.all([messagesTask, toolTask])

  // 流结束信号
  win?.webContents.send('agent:stream-done')
  console.log('[service] stream-done sent')
  // 通知调用方（agent:send）持久化产物清单，供历史回显恢复文件链接
  ctx.onArtifacts?.(collector.artifacts)
}
