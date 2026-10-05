import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { DocArtifactFile, AgentArtifactMeta } from '../../shared/contracts'
import {
  buildArtifactMeta,
  docArtifactFromWriteInput,
  extractDocArtifactsFromText
} from './doc-artifacts'

/** 工具调用流句柄（DeepAgent v3 run.toolCalls / run.subagents 的结构子集） */
export interface AgentToolCallHandle {
  name: string
  callId?: string
  input?: unknown
  output?: Promise<unknown>
  status?: Promise<string>
}

export interface AgentRunHandle {
  toolCalls: AsyncIterable<AgentToolCallHandle>
  subagents?: AsyncIterable<AgentRunHandle>
}

export interface ArtifactCollectorDeps {
  /** 事件出口（无窗口调用方传 null，事件静默丢弃） */
  win: BrowserWindow | null
  /** 会话绑定的工作空间 id（产物归属；缺省 null = 会话级） */
  workspaceId: string | null
  /** 工作空间目录（委派输出文本里提取文档产物的基准目录） */
  workspaceDir?: string
  /** 取消信号：文本流式预览随之中断 */
  signal?: AbortSignal
}

/**
 * 工具调用与文档产物流收集器。
 *
 * 历史实现是 handleToolCall 里 4 条字符串 if 分支（write_file/edit_file/download_asset/task|execute），
 * 新增产物型工具要改主流程；现改为**工具名 → 处理器注册表**（见 TOOL_CALL_HANDLERS），
 * 新增工具 = 加一条注册。
 *
 * 事件协议（渲染层消费）：artifact-start →（text 预览分片）→ artifact-end / artifact-error；
 * 委派（task）另有 delegate-start / delegate-end。产物清单在流结束后经 onArtifacts 交回调用方。
 */
export class ArtifactCollector {
  /** 已登记的产物清单（流结束交回 agent:send 持久化，供历史回显） */
  readonly artifacts: DocArtifactFile[] = []
  /** 会话绑定的工作空间 id（产物归属） */
  readonly workspaceId: string | null
  /** 工作空间目录（委派输出文本提取基准） */
  readonly workspaceDir?: string

  private readonly win: BrowserWindow | null
  private readonly signal?: AbortSignal
  private readonly handlers: ReadonlyMap<string, ToolCallHandler>

  constructor(deps: ArtifactCollectorDeps) {
    this.win = deps.win
    this.workspaceId = deps.workspaceId
    this.workspaceDir = deps.workspaceDir
    this.signal = deps.signal
    this.handlers = new Map(Object.entries(TOOL_CALL_HANDLERS))
  }

  /** 事件出口（无窗口时静默） */
  send(channel: string, payload: unknown): void {
    this.win?.webContents.send(channel, payload)
  }

  /** 递归遍历工具调用流（含嵌套子智能体） */
  async walkTools(run: AgentRunHandle): Promise<void> {
    // 测试/无工具运行的 stream 对象可能只有 messages 投影，防御处理
    if (!run.toolCalls) return
    for await (const call of run.toolCalls) {
      const handler = this.handlers.get(call.name)
      if (handler) await handler(call, this)
    }
    if (run.subagents) {
      for await (const sub of run.subagents) {
        await this.walkTools(sub)
      }
    }
  }

  /** 推送产物：start →（text 预览流式）→ end；失败发 artifact-error 且不入清单 */
  async pushArtifact(
    artifact: DocArtifactFile,
    content: string,
    done?: Promise<unknown>
  ): Promise<void> {
    if (this.artifacts.some((item) => item.relPath === artifact.relPath && item.ext === artifact.ext))
      return
    const artifactId = randomUUID()
    const meta: AgentArtifactMeta = buildArtifactMeta(artifactId, artifact)
    this.send('agent:artifact-start', meta)
    try {
      if (meta.preview === 'text' && content) {
        await this.streamArtifactText(artifactId, content)
      }
      if (done) await done
      this.send('agent:artifact-end', { artifactId, ok: true })
      this.artifacts.push(artifact)
    } catch (err) {
      this.send('agent:artifact-error', {
        artifactId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** 长文档分片预览（限速 + 总时长上限，超限一次性补推剩余） */
  private async streamArtifactText(artifactId: string, text: string): Promise<void> {
    const CHUNK_CHARS = 32
    const CHUNK_DELAY_MS = 6
    const MAX_TOTAL_DELAY_MS = 6000
    let offset = 0
    let totalDelay = 0
    while (offset < text.length) {
      if (this.signal?.aborted) break
      const piece = text.slice(offset, offset + CHUNK_CHARS)
      this.send('agent:artifact-chunk', { artifactId, text: piece })
      offset += piece.length
      if (offset >= text.length) break
      if (totalDelay >= MAX_TOTAL_DELAY_MS) break
      await delay(CHUNK_DELAY_MS)
      totalDelay += CHUNK_DELAY_MS
    }
    // 超时上限后一次性推送剩余内容，避免超长文档拖慢整体完成信号
    if (offset < text.length) {
      this.send('agent:artifact-chunk', { artifactId, text: text.slice(offset) })
    }
  }
}

/** 工具调用处理器（按工具名注册；新增产物型工具 = 加一条） */
type ToolCallHandler = (call: AgentToolCallHandle, collector: ArtifactCollector) => Promise<void>

const TOOL_CALL_HANDLERS: Record<string, ToolCallHandler> = {
  write_file: handleFileWrite,
  edit_file: handleFileWrite,
  download_asset: handleDownloadedAsset,
  task: handleDelegation,
  execute: handleDelegation
}

/** write_file / edit_file：从工具入参登记文档产物（text 预览走流式） */
async function handleFileWrite(
  call: AgentToolCallHandle,
  collector: ArtifactCollector
): Promise<void> {
  const filePath = toolInputString(call.input, 'file_path')
  const content = toolInputString(call.input, 'content') ?? ''
  const found = filePath ? docArtifactFromWriteInput(filePath, collector.workspaceId) : null
  if (found) {
    await collector.pushArtifact(found.artifact, content, call.output)
  }
}

/**
 * download_asset：素材（配图 / 成片）由工具直接落盘、不经 write_file，
 * 必须从工具输出登记，否则成片不会出现在消息产物区（方案 D-4）。
 */
async function handleDownloadedAsset(
  call: AgentToolCallHandle,
  collector: ArtifactCollector
): Promise<void> {
  const output = await Promise.resolve(call.output).catch(() => undefined)
  const relPath = assetRelPathFromOutput(output)
  const found = relPath ? docArtifactFromWriteInput(relPath, collector.workspaceId) : null
  if (found) {
    await collector.pushArtifact(found.artifact, '', undefined)
  }
}

/** task / execute：委派事件（仅 task） + 从委派输出文本提取文档产物 */
async function handleDelegation(
  call: AgentToolCallHandle,
  collector: ArtifactCollector
): Promise<void> {
  if (call.name === 'task') {
    // 委派专家（子智能体）事件：渲染层据此显示「正在委派…」动态状态，
    // 否则长任务期间界面完全无反馈（用户不知道当前进度）
    const callId = call.callId ?? randomUUID()
    const name = toolInputString(call.input, 'subagent_type') ?? '专家'
    const description = toolInputString(call.input, 'description')
    collector.send('agent:delegate-start', {
      callId,
      name,
      ...(description ? { description } : {})
    })
    void Promise.resolve(call.output)
      .then(() => collector.send('agent:delegate-end', { callId, ok: true }))
      .catch(() => collector.send('agent:delegate-end', { callId, ok: false }))
  }
  const outputText = contentToText(await (call.output ?? Promise.resolve('')).catch(() => ''))
  const extracted = extractDocArtifactsFromText(
    outputText,
    collector.workspaceDir,
    collector.workspaceId
  )
  for (const artifact of extracted) {
    await collector.pushArtifact(artifact, '', undefined)
  }
}

/**
 * 从 `download_asset` 的工具输出里取保存路径。
 *
 * 该工具返回 JSON（`{ relPath, absPath, size, mime, path, mime_type }`）；
 * 素材由工具直接落盘、不经过 write_file，因此必须从输出里登记，
 * 否则成片不会出现在消息产物区（方案 D-4）。
 */
function assetRelPathFromOutput(output: unknown): string {
  const text = contentToText(output).trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const candidate = parsed.relPath ?? parsed.path ?? parsed.rel_path
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  } catch {
    // 非纯 JSON：走下面的正则兜底
  }
  const matched = text.match(/"(?:relPath|path|rel_path)"\s*:\s*"([^"]+)"/)
  return matched ? matched[1].trim() : ''
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
