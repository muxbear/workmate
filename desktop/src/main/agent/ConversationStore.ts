import type { BaseCheckpointSaver, CheckpointTuple } from '@langchain/langgraph-checkpoint'
import type { Database } from 'better-sqlite3'

/** 会话绑定的工作空间（checkpoint metadata 派生；无绑定为 undefined，归"默认空间"） */
export interface ConversationWorkspace {
  id: string
  name: string
  dir?: string
}

/** 会话摘要（会话列表项） */
export interface ConversationSummary {
  id: string
  title: string
  createAt: number
  updateAt: number
  workspace?: ConversationWorkspace | null
}

/** 会话内 AI 轮次展示元信息（辅助表 conversation_turn_meta；实时补写，回显恢复） */
export interface ConversationTurnMeta {
  model?: string
  createdAt?: number
  durationMs?: number
}

/** 会话内文档产物（辅助表 conversation_doc_artifacts；消息区链接 + 右侧栏打开） */
export interface ConversationDocArtifact {
  name: string
  relPath: string
  ext: string
  workspaceId: string | null
}

/** 会话内消息（供 UI 展示：按轮折叠后的 user/assistant 消息，样式与实时一致） */
export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  /** 该轮 AI 生成/涉及的文档文件清单 */
  files?: ConversationDocArtifact[]
  /** AI 轮次展示元信息（模型/开始时间/耗时） */
  meta?: ConversationTurnMeta
}

/** 会话内原始 checkpoint 消息（供 agent:send 图输入重建；含 tool/system 与工具关联字段） */
export interface RawConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  /** 深度思考内容（checkpoint 中 AI 消息 blocks 的 reasoning 块提取） */
  reasoning?: string
  /** 原始内容块（content 为数组时原样保留，供图输入透传；string 旧数据无此字段） */
  rawContent?: unknown
  /** ToolMessage 对应的工具调用 id（重建模型输入时使用） */
  toolCallId?: string
  /** ToolMessage 的工具名 */
  toolName?: string
}

// 标记格式的权威来源是 file-parts.expandFilePart，改动需同步
/** 文本文件块：`【文件：name】\n…内容…\n【文件内容结束】` */
const FILE_CONTENT_RE = /^【文件：(.+?)】\n[\s\S]*?\n【文件内容结束】$/
/** 图片标记块（无内容体，后随 image_url 二元组）：`【文件：name】` */
const FILE_MARKER_RE = /^【文件：(.+?)】$/

/**
 * 折叠文件附件块为「📎 文件名」：
 * - 文本文件块（带内容体）→ 折叠，不消费后续块
 * - 图片标记块（无内容体）→ 折叠，并消费紧随的 image_url 块（二元组）
 * 不匹配返回 null
 */
function collapseFileBlock(text: string): { label: string; consumeNextImage: boolean } | null {
  const contentMatch = FILE_CONTENT_RE.exec(text)
  if (contentMatch) return { label: `📎 ${contentMatch[1]}`, consumeNextImage: false }
  const markerMatch = FILE_MARKER_RE.exec(text)
  if (markerMatch) return { label: `📎 ${markerMatch[1]}`, consumeNextImage: true }
  return null
}

/**
 * 解析新版 LangChain 消息块 content（checkpoint 中 AI 消息 content 为 blocks 数组）：
 * - `{ type: 'text', text }` 块拼接为正文（markdown），文件附件块折叠为「📎 文件名」
 * - `{ type: 'reasoning', reasoning }` 块提取为思考内容
 * - tool_use 等其余块忽略
 * string content 原样返回（旧格式/用户消息）
 */
function parseBlocks(content: unknown): { content: string; reasoning?: string } {
  if (typeof content === 'string') return { content }
  if (!Array.isArray(content)) return { content: '' }
  const parts: string[] = []
  const reasoningParts: string[] = []
  let consumeNextImage = false
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      // 非对象块（防御性分支）也重置消费状态，对齐「其余块重置」spec
      consumeNextImage = false
      continue
    }
    const b = block as { type?: string; text?: unknown; reasoning?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      const collapsed = collapseFileBlock(b.text)
      if (collapsed) {
        parts.push(collapsed.label)
        consumeNextImage = collapsed.consumeNextImage
      } else {
        parts.push(b.text)
        consumeNextImage = false
      }
    } else if (b.type === 'reasoning' && typeof b.reasoning === 'string') {
      reasoningParts.push(b.reasoning)
    } else if (b.type === 'image_url') {
      // 文件标记块后紧随的图片块：折叠时已展示文件名，跳过
      if (!consumeNextImage) parts.push('📎 图片')
      consumeNextImage = false
    } else {
      consumeNextImage = false
    }
  }
  return {
    content: parts.join(''),
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined
  }
}

const THREAD_PREFIX = 'u:'
/** 自动派生标题的长度上限（AI 总结与首条消息截断兜底统一严格限制） */
const TITLE_MAX_LEN = 20
const DEFAULT_TITLE = '新对话'

/**
 * 基于 LangGraph checkpointer 的会话读写服务
 *
 * 会话数据全部存于 LangGraph 短期记忆（checkpointer）：
 * - thread_id = `u:{userId}:{conversationId}`（userId 前缀实现用户隔离）
 * - 会话列表 = checkpointer.list() 全量扫描 + 前缀过滤
 * - 消息历史 = checkpoint state 的 messages 通道（channel_values.messages）
 * - 删除会话 = checkpointer.deleteThread()
 */
export class ConversationStore {
  constructor(
    private readonly getCheckpointer: () => BaseCheckpointSaver,
    private readonly getDb?: () => Database
  ) {}

  /** 读取用户全部会话的自定义标题（conversation_titles 表，按用户隔离） */
  private loadCustomTitles(userId: string): Map<string, string> {
    const map = new Map<string, string>()
    if (!this.getDb) return map
    try {
      const rows = this.getDb()
        .prepare('SELECT conversation_id, title FROM conversation_titles WHERE user_id = ?')
        .all(userId) as Array<{ conversation_id: string; title: string }>
      for (const row of rows) map.set(row.conversation_id, row.title)
    } catch (err) {
      console.error('[ConversationStore] loadCustomTitles failed:', err)
    }
    return map
  }

  /** 读取用户全部会话的工作空间绑定（conversation_workspaces 表，按用户隔离） */
  private loadWorkspaceBindings(userId: string): Map<string, ConversationWorkspace> {
    const map = new Map<string, ConversationWorkspace>()
    if (!this.getDb) return map
    try {
      const rows = this.getDb()
        .prepare(
          'SELECT conversation_id, workspace_id, workspace_name, workspace_dir FROM conversation_workspaces WHERE user_id = ?'
        )
        .all(userId) as Array<{
        conversation_id: string
        workspace_id: string
        workspace_name: string | null
        workspace_dir: string | null
      }>
      for (const row of rows) {
        map.set(row.conversation_id, {
          id: row.workspace_id,
          name: row.workspace_name ?? '',
          ...(row.workspace_dir ? { dir: row.workspace_dir } : {})
        })
      }
    } catch (err) {
      console.error('[ConversationStore] loadWorkspaceBindings failed:', err)
    }
    return map
  }

  /**
   * 绑定会话到工作空间（业务表显式存储；LangGraph checkpoint metadata 不可靠，不能作为唯一来源）
   * 未选择工作空间（ws 为 null）时调用将移除既有绑定（会话归默认空间）
   */
  bindWorkspace(
    userId: string,
    conversationId: string,
    ws: { id: string; name: string; dir?: string } | null
  ): void {
    if (!this.getDb) return
    const db = this.getDb()
    if (!ws) {
      db.prepare(
        'DELETE FROM conversation_workspaces WHERE user_id = ? AND conversation_id = ?'
      ).run(userId, conversationId)
      return
    }
    db.prepare(
      'INSERT INTO conversation_workspaces (user_id, conversation_id, workspace_id, workspace_name, workspace_dir, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, conversation_id) DO UPDATE SET ' +
        'workspace_id = excluded.workspace_id, workspace_name = excluded.workspace_name, ' +
        'workspace_dir = excluded.workspace_dir, updated_at = excluded.updated_at'
    ).run(userId, conversationId, ws.id, ws.name, ws.dir ?? null, Date.now())
  }

  /** 工作空间目录迁移后同步会话绑定表里的目录快照（按 workspace_id 全量更新） */
  syncWorkspaceDirs(moves: Array<{ workspaceId: string; to: string }>): void {
    if (!this.getDb || moves.length === 0) return
    const stmt = this.getDb().prepare(
      'UPDATE conversation_workspaces SET workspace_dir = ? WHERE workspace_id = ?'
    )
    for (const move of moves) {
      stmt.run(move.to, move.workspaceId)
    }
  }

  /** 构造 thread_id（用户隔离单点：入参不信任，统一由 userId 合成） */
  buildThreadId(userId: string, conversationId: string): string {
    return `${THREAD_PREFIX}${userId}:${conversationId}`
  }

  /** 从 checkpoint metadata 宽容读取工作空间绑定（旧会话无该字段返回 null） */
  private readWorkspace(tuple: CheckpointTuple): ConversationWorkspace | null {
    const ws = (tuple.metadata as Record<string, unknown> | undefined)?.workspace as
      { id?: unknown; name?: unknown; dir?: unknown } | undefined
    if (!ws || typeof ws.id !== 'string' || !ws.id) return null
    return {
      id: ws.id,
      name: typeof ws.name === 'string' ? ws.name : '',
      dir: typeof ws.dir === 'string' ? ws.dir : undefined
    }
  }

  /** 从 checkpoint 派生会话标题（兜底）：首条 user 消息解析（string 或新版 blocks 数组）后截断 */
  private deriveTitle(tuple: CheckpointTuple): string {
    const messages = tuple.checkpoint.channel_values?.messages as
      Array<{ role?: string; content?: unknown }> | undefined
    const firstUser = messages?.find((m) => m.role === 'user' || m.role === 'human')
    const parsed = firstUser ? parseBlocks(firstUser.content) : { content: '' }
    const content = parsed.content.trim()
    if (!content) return DEFAULT_TITLE
    return content.length > TITLE_MAX_LEN ? `${content.slice(0, TITLE_MAX_LEN)}...` : content
  }

  /**
   * 保存 AI 总结标题（conversation_titles 表，INSERT OR IGNORE——不覆盖用户手动重命名）
   * 列表读取时 customTitles 优先于派生标题
   */
  saveAutoTitle(userId: string, conversationId: string, title: string): void {
    if (!this.getDb) return
    this.getDb()
      .prepare(
        'INSERT OR IGNORE INTO conversation_titles (user_id, conversation_id, title, updated_at) ' +
          'VALUES (?, ?, ?, ?)'
      )
      .run(userId, conversationId, title.slice(0, TITLE_MAX_LEN), Date.now())
  }

  /** 列出某用户的全部会话（按更新时间降序） */
  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const checkpointer = this.getCheckpointer()
    const prefix = `${THREAD_PREFIX}${userId}:`

    const tuples: CheckpointTuple[] = []
    for await (const tuple of checkpointer.list({})) {
      const threadId = tuple.config.configurable?.thread_id
      if (typeof threadId === 'string' && threadId.startsWith(prefix)) {
        tuples.push(tuple)
      }
    }

    tuples.sort((a, b) => {
      const at = (a.metadata as Record<string, unknown> | undefined)?.updated_at as Date | undefined
      const bt = (b.metadata as Record<string, unknown> | undefined)?.updated_at as Date | undefined
      return (bt ?? new Date(0)).getTime() - (at ?? new Date(0)).getTime()
    })

    // 同一会话（thread_id）的多个 checkpoint 版本（LangGraph 图的每步都保存）只保留最新一个，
    // 否则侧栏会出现多个相同 id 的任务项（hover 菜单同时打开、数据重复展示）
    const seenThreads = new Set<string>()
    const uniqueTuples: CheckpointTuple[] = []
    for (const tuple of tuples) {
      const threadId = tuple.config.configurable?.thread_id
      if (typeof threadId !== 'string' || seenThreads.has(threadId)) continue
      seenThreads.add(threadId)
      uniqueTuples.push(tuple)
    }

    // 自定义标题（重命名）优先，未覆盖时用首条消息派生标题
    const customTitles = this.loadCustomTitles(userId)
    // 工作空间绑定：业务表显式存储优先（可靠），checkpoint metadata 兜底（历史数据）
    const bindings = this.loadWorkspaceBindings(userId)

    return uniqueTuples.map((tuple) => {
      const threadId = tuple.config.configurable?.thread_id as string
      const conversationId = threadId.slice(prefix.length)
      const meta = tuple.metadata as Record<string, unknown> | undefined
      const created = (meta?.created_at as Date | undefined) ?? new Date(0)
      const updated = (meta?.updated_at as Date | undefined) ?? created
      return {
        id: conversationId,
        title: customTitles.get(conversationId) ?? this.deriveTitle(tuple),
        createAt: created.getTime(),
        updateAt: updated.getTime(),
        workspace: bindings.get(conversationId) ?? this.readWorkspace(tuple)
      }
    })
  }

  /** 重命名会话（自定义标题写 conversation_titles 表，列表读取时优先） */
  async renameConversation(userId: string, conversationId: string, title: string): Promise<void> {
    if (!this.getDb) throw new Error('会话重命名不可用')
    const trimmed = title.trim().slice(0, 50)
    if (!trimmed) throw new Error('标题不能为空')
    this.getDb()
      .prepare(
        'INSERT INTO conversation_titles (user_id, conversation_id, title, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, conversation_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at'
      )
      .run(userId, conversationId, trimmed, Date.now())
  }

  /** 读取会话绑定的工作空间（agent:send 时主进程权威解析：已绑定 > 渲染层当前选择） */
  async getWorkspace(
    userId: string,
    conversationId: string
  ): Promise<ConversationWorkspace | null> {
    // 业务表绑定优先（可靠）；checkpoint metadata 兜底（历史数据）
    if (this.getDb) {
      const row = this.getDb()
        .prepare(
          'SELECT workspace_id, workspace_name, workspace_dir FROM conversation_workspaces WHERE user_id = ? AND conversation_id = ?'
        )
        .get(userId, conversationId) as
        | { workspace_id: string; workspace_name: string | null; workspace_dir: string | null }
        | undefined
      if (row) {
        return {
          id: row.workspace_id,
          name: row.workspace_name ?? '',
          ...(row.workspace_dir ? { dir: row.workspace_dir } : {})
        }
      }
    }
    const checkpointer = this.getCheckpointer()
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: this.buildThreadId(userId, conversationId) }
    })
    if (!tuple) return null
    return this.readWorkspace(tuple)
  }

  /** 读取最新 checkpoint 的 messages 原始对象（不做展示折叠；越权校验：thread_id 由 userId 合成） */
  private async readCheckpointMessages(
    userId: string,
    conversationId: string
  ): Promise<
    Array<{
      id?: string
      getType?: () => string
      role?: string
      content?: unknown
      tool_call_id?: unknown
      name?: unknown
    }>
  > {
    const checkpointer = this.getCheckpointer()
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: this.buildThreadId(userId, conversationId) }
    })
    if (!tuple) return []
    const messages = tuple.checkpoint.channel_values?.messages
    if (!Array.isArray(messages)) return []
    return messages as Array<{
      id?: string
      getType?: () => string
      role?: string
      content?: unknown
      tool_call_id?: unknown
      name?: unknown
    }>
  }

  /** 读取会话原始消息（agent:send 重建图输入用；保留 tool/system 与工具调用关联，不折叠） */
  async getRawMessages(userId: string, conversationId: string): Promise<RawConversationMessage[]> {
    const messages = await this.readCheckpointMessages(userId, conversationId)
    return messages
      .map((msg) => {
        const rawRole = typeof msg.getType === 'function' ? msg.getType() : msg.role
        let role: RawConversationMessage['role']
        switch (rawRole) {
          case 'human':
            role = 'user'
            break
          case 'ai':
            role = 'assistant'
            break
          case 'tool':
            role = 'tool'
            break
          case 'system':
            role = 'system'
            break
          default:
            return null
        }
        const parsed = parseBlocks(msg.content)
        const out: RawConversationMessage = {
          id: msg.id ?? '',
          role,
          content: parsed.content,
          ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
          // content 为数组时原样保留原始块（图输入透传用）；string/非数组对象旧数据不设该字段
          ...(Array.isArray(msg.content) ? { rawContent: msg.content } : {})
        }
        if (role === 'tool') {
          if (typeof msg.tool_call_id === 'string' && msg.tool_call_id) {
            out.toolCallId = msg.tool_call_id
          }
          if (typeof msg.name === 'string' && msg.name) {
            out.toolName = msg.name
          }
        }
        return out
      })
      .filter((m): m is RawConversationMessage => m !== null)
  }

  /** 读取会话内展示消息（conversation:get 回显用）：按 user 消息为界折叠为一问一答，
   *  tool/system 不渲染，并挂接本地辅助表里的轮次元信息与文档产物（与实时展示一致） */
  async getMessages(userId: string, conversationId: string): Promise<ConversationMessage[]> {
    const raw = await this.getRawMessages(userId, conversationId)
    if (raw.length === 0) return []

    // 辅助表：轮次元信息 + 文档产物（旧会话无记录则静默缺省）
    const metaByTurn = new Map<number, ConversationTurnMeta>()
    const artifactsByTurn = new Map<number, ConversationDocArtifact[]>()
    if (this.getDb) {
      try {
        const db = this.getDb()
        const metaRows = db
          .prepare(
            'SELECT turn_index, model, created_at_ms, duration_ms FROM conversation_turn_meta WHERE user_id = ? AND conversation_id = ?'
          )
          .all(userId, conversationId) as Array<{
          turn_index: number
          model: string | null
          created_at_ms: number | null
          duration_ms: number | null
        }>
        for (const row of metaRows) {
          const meta: ConversationTurnMeta = {}
          if (row.model) meta.model = row.model
          if (row.created_at_ms !== null && row.created_at_ms !== undefined)
            meta.createdAt = row.created_at_ms
          if (row.duration_ms !== null && row.duration_ms !== undefined)
            meta.durationMs = row.duration_ms
          metaByTurn.set(row.turn_index, meta)
        }
        const artifactRows = db
          .prepare(
            'SELECT turn_index, name, rel_path, ext, workspace_id FROM conversation_doc_artifacts WHERE user_id = ? AND conversation_id = ? ORDER BY turn_index, id'
          )
          .all(userId, conversationId) as Array<{
          turn_index: number
          name: string
          rel_path: string
          ext: string
          workspace_id: string | null
        }>
        for (const row of artifactRows) {
          const list = artifactsByTurn.get(row.turn_index) ?? []
          list.push({
            name: row.name,
            relPath: row.rel_path,
            ext: row.ext,
            workspaceId: row.workspace_id
          })
          artifactsByTurn.set(row.turn_index, list)
        }
      } catch (err) {
        console.error('[ConversationStore] load turn meta/artifacts failed:', err)
      }
    }

    // 折叠：每个 user 消息与其后的所有 AI 消息合并为一个 assistant 展示消息
    interface TurnAccumulator {
      user: RawConversationMessage | null
      assistantId: string | null
      contents: string[]
      reasonings: string[]
      turnIndex: number
    }
    const turns: TurnAccumulator[] = []
    let turnIndex = 0
    let current: TurnAccumulator | null = null
    for (const msg of raw) {
      if (msg.role === 'user') {
        turnIndex += 1
        current = { user: msg, assistantId: null, contents: [], reasonings: [], turnIndex }
        turns.push(current)
      } else if (msg.role === 'assistant') {
        if (!current) {
          // 异常形态：AI 消息先于任何 user 消息（如 agent 主动开场），按独立轮次展示
          turnIndex += 1
          current = { user: null, assistantId: null, contents: [], reasonings: [], turnIndex }
          turns.push(current)
        }
        current.assistantId = msg.id
        if (msg.content) current.contents.push(msg.content)
        if (msg.reasoning) current.reasonings.push(msg.reasoning)
      }
      // tool/system 消息不参与展示（实时流也不渲染）
    }

    const out: ConversationMessage[] = []
    for (const turn of turns) {
      if (turn.user) {
        out.push({ id: turn.user.id, role: 'user', content: turn.user.content })
      }
      if (turn.assistantId === null) continue
      const content = turn.contents.join('')
      const reasoning = turn.reasonings.length ? turn.reasonings.join('') : undefined
      const message: ConversationMessage = { id: turn.assistantId, role: 'assistant', content }
      if (reasoning) message.reasoning = reasoning
      const meta = metaByTurn.get(turn.turnIndex)
      if (meta) message.meta = meta
      const files = artifactsByTurn.get(turn.turnIndex)
      if (files && files.length > 0) message.files = files
      out.push(message)
    }
    return out
  }

  /** 保存某 AI 轮次展示元信息（实时发送结束补写；同轮重发时覆盖） */
  saveTurnMeta(
    userId: string,
    conversationId: string,
    turnIndex: number,
    meta: ConversationTurnMeta
  ): void {
    if (!this.getDb) throw new Error('会话元信息不可用')
    this.getDb()
      .prepare(
        'INSERT INTO conversation_turn_meta (user_id, conversation_id, turn_index, model, created_at_ms, duration_ms, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, conversation_id, turn_index) DO UPDATE SET ' +
          'model = excluded.model, created_at_ms = excluded.created_at_ms, duration_ms = excluded.duration_ms, updated_at = excluded.updated_at'
      )
      .run(
        userId,
        conversationId,
        turnIndex,
        meta.model ?? null,
        meta.createdAt ?? null,
        meta.durationMs ?? null,
        Date.now()
      )
  }

  /** 覆盖保存某 AI 轮次的文档产物清单（重新生成后以新结果替换旧记录） */
  saveTurnArtifacts(
    userId: string,
    conversationId: string,
    turnIndex: number,
    artifacts: ConversationDocArtifact[]
  ): void {
    if (!this.getDb) return
    const db = this.getDb()
    const remove = db.prepare(
      'DELETE FROM conversation_doc_artifacts WHERE user_id = ? AND conversation_id = ? AND turn_index = ?'
    )
    const insert = db.prepare(
      'INSERT INTO conversation_doc_artifacts (user_id, conversation_id, turn_index, name, rel_path, ext, workspace_id, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const now = Date.now()
    db.transaction(() => {
      remove.run(userId, conversationId, turnIndex)
      for (const artifact of artifacts) {
        insert.run(
          userId,
          conversationId,
          turnIndex,
          artifact.name,
          artifact.relPath,
          artifact.ext,
          artifact.workspaceId,
          now
        )
      }
    })()
  }

  /** 删除某轮次起（含）的元信息与文档产物（regenerate 截断旧回复时清理） */
  deleteTurnDataFrom(userId: string, conversationId: string, fromTurnIndex: number): void {
    if (!this.getDb) return
    this.getDb()
      .prepare(
        'DELETE FROM conversation_turn_meta WHERE user_id = ? AND conversation_id = ? AND turn_index >= ?'
      )
      .run(userId, conversationId, fromTurnIndex)
    this.getDb()
      .prepare(
        'DELETE FROM conversation_doc_artifacts WHERE user_id = ? AND conversation_id = ? AND turn_index >= ?'
      )
      .run(userId, conversationId, fromTurnIndex)
  }

  /** 删除会话（删 checkpoint + 自定义标题/工作空间绑定记录；store 长期记忆按用户命名空间，不随会话删除） */
  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    const checkpointer = this.getCheckpointer()
    await checkpointer.deleteThread(this.buildThreadId(userId, conversationId))
    if (this.getDb) {
      this.getDb()
        .prepare('DELETE FROM conversation_titles WHERE user_id = ? AND conversation_id = ?')
        .run(userId, conversationId)
      this.getDb()
        .prepare('DELETE FROM conversation_workspaces WHERE user_id = ? AND conversation_id = ?')
        .run(userId, conversationId)
      this.getDb()
        .prepare('DELETE FROM conversation_turn_meta WHERE user_id = ? AND conversation_id = ?')
        .run(userId, conversationId)
      this.getDb()
        .prepare('DELETE FROM conversation_doc_artifacts WHERE user_id = ? AND conversation_id = ?')
        .run(userId, conversationId)
    }
  }

  /**
   * 删除绑定到指定工作空间的全部会话（按 conversation_workspaces 业务表，逐个删 checkpoint/标题/绑定）；
   * 仅 metadata 绑定（无业务表记录）的旧会话不在此范围，随空间记录删除后归默认空间；
   * 中途失败时部分删除、不回滚（异常向上抛）；返回删除数量
   */
  async deleteConversationsByWorkspace(userId: string, workspaceId: string): Promise<number> {
    if (!this.getDb) return 0
    const rows = this.getDb()
      .prepare(
        'SELECT conversation_id FROM conversation_workspaces WHERE user_id = ? AND workspace_id = ?'
      )
      .all(userId, workspaceId) as Array<{ conversation_id: string }>
    for (const row of rows) {
      await this.deleteConversation(userId, row.conversation_id)
    }
    return rows.length
  }
}
