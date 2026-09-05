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
import type { RawConversationMessage } from './ConversationStore'
import type { DocArtifactFile, AgentArtifactMeta } from '../../preload/index.d'
import { randomUUID } from 'crypto'
import {
  buildArtifactMeta,
  docArtifactFromWriteInput,
  extractDocArtifactsFromText
} from './doc-artifacts'

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

/** 工具调用流句柄（DeepAgent v3 run.toolCalls / run.subagents 的结构子集） */
interface AgentToolCallHandle {
  name: string
  callId?: string
  input?: unknown
  output?: Promise<unknown>
  status?: Promise<string>
}

interface AgentRunHandle {
  toolCalls: AsyncIterable<AgentToolCallHandle>
  subagents?: AsyncIterable<AgentRunHandle>
}

/** LangChain 消息 content（string / blocks 数组 / 消息对象）统一取文本 */
function contentToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => contentToText(item)).join('')
  }
  if (value && typeof value === 'object') {
    const obj = value as { content?: unknown; text?: unknown }
    if (obj.content !== undefined) return contentToText(obj.content)
    if (obj.text !== undefined) return contentToText(obj.text)
  }
  return ''
}

function toolInputString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function invokeSendMessage(
  messages: BaseMessage[],
  win: BrowserWindow,
  agent: DeepAgent,
  config: AgentRunConfig,
  signal?: AbortSignal,
  onArtifacts?: (artifacts: DocArtifactFile[]) => void
): Promise<void> {
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
        ...(config.modelOverride ? { model_override: config.modelOverride } : {})
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
  const artifacts: DocArtifactFile[] = []

  async function streamArtifactText(artifactId: string, text: string): Promise<void> {
    const CHUNK_CHARS = 32
    const CHUNK_DELAY_MS = 6
    const MAX_TOTAL_DELAY_MS = 6000
    let offset = 0
    let totalDelay = 0
    while (offset < text.length) {
      if (signal?.aborted) break
      const piece = text.slice(offset, offset + CHUNK_CHARS)
      win.webContents.send('agent:artifact-chunk', { artifactId, text: piece })
      offset += piece.length
      if (offset >= text.length) break
      if (totalDelay >= MAX_TOTAL_DELAY_MS) break
      await delay(CHUNK_DELAY_MS)
      totalDelay += CHUNK_DELAY_MS
    }
    // 超时上限后一次性推送剩余内容，避免超长文档拖慢整体完成信号
    if (offset < text.length) {
      win.webContents.send('agent:artifact-chunk', { artifactId, text: text.slice(offset) })
    }
  }

  async function pushArtifact(
    artifact: DocArtifactFile,
    content: string,
    done?: Promise<unknown>
  ): Promise<void> {
    if (artifacts.some((item) => item.relPath === artifact.relPath && item.ext === artifact.ext))
      return
    const artifactId = randomUUID()
    const meta: AgentArtifactMeta = buildArtifactMeta(artifactId, artifact)
    win.webContents.send('agent:artifact-start', meta)
    try {
      if (meta.preview === 'text' && content) {
        await streamArtifactText(artifactId, content)
      }
      if (done) await done
      win.webContents.send('agent:artifact-end', { artifactId, ok: true })
      artifacts.push(artifact)
    } catch (err) {
      win.webContents.send('agent:artifact-error', {
        artifactId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  async function handleToolCall(call: AgentToolCallHandle): Promise<void> {
    if (call.name === 'write_file' || call.name === 'edit_file') {
      const filePath = toolInputString(call.input, 'file_path')
      const content = toolInputString(call.input, 'content') ?? ''
      const found = filePath
        ? docArtifactFromWriteInput(filePath, config.workspace?.id ?? null)
        : null
      if (found) {
        await pushArtifact(found.artifact, content, call.output as Promise<unknown> | undefined)
      }
      return
    }
    if (call.name === 'task' || call.name === 'execute') {
      const outputText = contentToText(await (call.output ?? Promise.resolve('')).catch(() => ''))
      const baseDir = config.workspace_dir ?? config.workspace?.dir
      const extracted = extractDocArtifactsFromText(
        outputText,
        baseDir,
        config.workspace?.id ?? null
      )
      for (const artifact of extracted) {
        await pushArtifact(artifact, '', undefined)
      }
    }
  }

  async function walkToolCalls(run: AgentRunHandle): Promise<void> {
    // 测试/无工具运行的 stream 对象可能只有 messages 投影，防御处理
    if (!run.toolCalls) return
    for await (const call of run.toolCalls) {
      await handleToolCall(call)
    }
    if (run.subagents) {
      for await (const sub of run.subagents) {
        await walkToolCalls(sub)
      }
    }
  }

  const messagesTask = (async (): Promise<void> => {
    let chunkCount = 0
    for await (const chunk of events.messages) {
      // 先处理 reasoning（深度思考）流
      let reasoningCount = 0
      for await (const token of chunk.reasoning) {
        reasoningCount++
        win.webContents.send('agent:stream-thinking', token)
      }
      if (reasoningCount > 0) {
        console.log('[service] reasoning done, tokens:', reasoningCount)
        win.webContents.send('agent:stream-thinking-done')
      }

      // 再处理 text（正式回复）流
      let textCount = 0
      for await (const text of chunk.text) {
        textCount++
        chunkCount++
        win.webContents.send('agent:stream-chunk', text)
      }
      console.log(
        '[service] message chunk done, text pieces:',
        textCount,
        'reasoning pieces:',
        reasoningCount
      )
    }
    console.log('[service] all messages done, total text chunks sent:', chunkCount)
  })()

  const toolTask = walkToolCalls(events as unknown as AgentRunHandle)

  await Promise.all([messagesTask, toolTask])

  // 流结束信号
  win.webContents.send('agent:stream-done')
  console.log('[service] stream-done sent')
  // 通知调用方（agent:send）持久化产物清单，供历史回显恢复文件链接
  onArtifacts?.(artifacts)
}
