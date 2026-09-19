// ---- SSE event types ----

export type SseEventType =
  | 'agent_start'
  | 'agent_end'
  | 'token'
  | 'reasoning'
  | 'tool_start'
  | 'tool_output'
  | 'tool_end'
  | 'error'
  | 'done'

export interface AgentStartData {
  agent_name: string
  agent_type: 'main' | 'sub'
  call_id: string
}

export interface AgentEndData {
  agent_name: string
  call_id: string
  status: string
  error?: string
}

export interface ToolStartData {
  tool_name: string
  call_id: string
  agent_name: string
  input: string
}

export interface ToolEndData {
  tool_name: string
  call_id: string
  output: string
}

// ---- Execution block types (trace mode) ----

export interface ToolCallInfo {
  callId: string
  name: string
  input: string
  output: string
  status: 'running' | 'completed' | 'failed'
}

export interface SubAgentInfo {
  callId: string
  name: string
  status: 'running' | 'completed' | 'failed'
  blocks: ExecutionBlock[]
}

export type ExecutionBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo }
  | { type: 'sub_agent'; subAgent: SubAgentInfo }

// ---- Chat message ----

export interface AttachmentDisplayInfo {
  filename: string
  mimeType: string
  size: number
  thumbnailUrl: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  streaming: boolean
  /** Execution blocks — only populated when traceEnabled is on */
  blocks?: ExecutionBlock[]
  /** Attachments to display in the message area */
  attachments?: AttachmentDisplayInfo[]
  /** 本次回复耗时（毫秒，服务端 done 事件回传） */
  durationMs?: number
  /** 本次回复产生的产物文件 */
  artifacts?: ChatArtifact[]
  /** 回复使用的模型名（服务端选择项回显或前端快照） */
  model?: string
  /** 消息创建时间（毫秒时间戳） */
  createdAt?: number
  /** 点赞 / 点踩本地状态 */
  feedback?: 'up' | 'down' | null
}

// ---- Legacy (kept for backward compat, no longer emitted by backend) ----

export type TraceEventType =
  | 'agent_start'
  | 'agent_end'
  | 'tool_start'
  | 'tool_end'
  | 'subagent_start'
  | 'subagent_end'

export interface TraceEntry {
  id: number
  type: TraceEventType
  name: string
  agent?: string
  input?: string
  output?: string
  status?: string
}

// ---- Attachment ----

export type AttachmentStatus = 'uploading' | 'success' | 'failed'

export interface Attachment {
  id: string
  serverId?: string
  file: File
  filename: string
  size: number
  mimeType: string
  status: AttachmentStatus
  progress: number
}

// ---- 输入框保序部件（与后端 ChatPart 对应） ----

export type ChatInputPart =
  | { type: 'text'; text: string }
  | { type: 'file'; attachmentId: string; filename: string }

// ---- 会话级选择项（对齐桌面版「新建任务」输入卡） ----

export type ChatMode = 'default' | 'files' | 'knowledge'

export interface ChatSelection {
  expertId: string | null
  expertName: string | null
  expertPrompt: string
  skillIds: string[]
  kbIds: string[]
  mode: ChatMode
  model: string | null
  /** 模型记录 id（服务端按 providerId + modelId 覆盖本次对话模型） */
  modelId: string | null
  providerId: string | null
  webSearch: boolean
  /** 会话工作区（沙箱内的逻辑目录名） */
  workspaceId: string | null
  /** 允许联网访问外部资源 */
  allowNetwork: boolean
  /** 允许执行命令与代码 */
  allowShell: boolean
}

/** 服务端 selection 事件回显：本次实际生效的选择项 */
export interface SelectionEcho {
  expert_id?: string
  expert_name?: string
  expert_missing?: string
  skills?: { id: string; name: string }[]
  kbs?: { id: string; name: string }[]
  mode?: string
  model?: string | null
  provider_id?: string | null
  web_search?: boolean
  allow_network?: boolean
  allow_shell?: boolean
  workspace_id?: string | null
}

/** 选择项初始值 */
export function createEmptySelection(): ChatSelection {
  return {
    expertId: null,
    expertName: null,
    expertPrompt: '',
    skillIds: [],
    kbIds: [],
    mode: 'default',
    model: null,
    modelId: null,
    providerId: null,
    webSearch: false,
    workspaceId: null,
    allowNetwork: false,
    allowShell: false,
  }
}

/** 会话产物（智能体生成的沙箱文件） */
export interface ChatArtifact {
  path: string
  name: string
  source_tool: string
  created_at: number
  /** MIME 类型（按扩展名推断） */
  mime_type?: string
  /** 文件大小（字节，0 表示尚未解析） */
  size?: number
}
