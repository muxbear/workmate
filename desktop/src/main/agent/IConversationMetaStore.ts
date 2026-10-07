import type {
  ConversationDocArtifact,
  ConversationMessage,
  ConversationSummary,
  ConversationTurnMeta,
  ConversationWorkspace,
  RawConversationMessage
} from './ConversationStore'

/**
 * 会话元信息存储契约（R8-1 后补抽，2026-10-05）：ConversationStore 的接口。
 *
 * 消费方（conversation/workspace handlers、AutomationRunner）依赖本接口而非具体类。
 * 说明：checkpoint 读写在实现内完成（构造注入 checkpointer），本接口只描述
 * 对外可见的会话元信息 / 绑定 / 生命周期行为。方法签名与实现逐字一致。
 */
export interface IConversationMetaStore {
  /**
   * 绑定会话到工作空间（业务表显式存储；checkpoint metadata 不可靠）。
   * ws 为 null 时移除既有绑定（会话归默认空间）。
   */
  bindWorkspace(
    userId: string,
    conversationId: string,
    ws: { id: string; name: string; dir?: string } | null
  ): void

  /** 工作空间目录迁移后同步会话绑定表里的目录快照（按 workspace_id 全量更新） */
  syncWorkspaceDirs(moves: Array<{ workspaceId: string; to: string }>): void

  /** 工作空间改名后同步会话绑定表里的名称快照（按 workspace_id 全量更新） */
  syncWorkspaceNames(renames: Array<{ workspaceId: string; name: string }>): void

  /** 构造 thread_id（用户隔离单点：入参不信任，统一由 userId 合成） */
  buildThreadId(userId: string, conversationId: string): string

  /** 保存 AI 总结标题（INSERT OR IGNORE——不覆盖用户手动重命名） */
  saveAutoTitle(userId: string, conversationId: string, title: string): void

  /** 列出某用户的全部会话（按更新时间降序） */
  listConversations(userId: string): Promise<ConversationSummary[]>

  /** 重命名会话（自定义标题写 conversation_titles 表，列表读取时优先） */
  renameConversation(userId: string, conversationId: string, title: string): Promise<void>

  /** 读取会话绑定的工作空间（agent:send 时主进程权威解析：已绑定 > 渲染层当前选择） */
  getWorkspace(userId: string, conversationId: string): Promise<ConversationWorkspace | null>

  /** 读取会话原始消息（agent:send 重建图输入用；保留 tool/system 与工具调用关联，不折叠） */
  getRawMessages(userId: string, conversationId: string): Promise<RawConversationMessage[]>

  /** 读取会话内展示消息（conversation:get 回显用；按 user 消息为界折叠为一问一答） */
  getMessages(userId: string, conversationId: string): Promise<ConversationMessage[]>

  /** 保存某 AI 轮次展示元信息（实时发送结束补写；同轮重发时覆盖） */
  saveTurnMeta(
    userId: string,
    conversationId: string,
    turnIndex: number,
    meta: ConversationTurnMeta
  ): void

  /** 覆盖保存某 AI 轮次的文档产物清单（重新生成后以新结果替换旧记录） */
  saveTurnArtifacts(
    userId: string,
    conversationId: string,
    turnIndex: number,
    artifacts: ConversationDocArtifact[]
  ): void

  /** 删除某轮次起（含）的元信息与文档产物（regenerate 截断旧回复时清理） */
  deleteTurnDataFrom(userId: string, conversationId: string, fromTurnIndex: number): void

  /** 删除会话（删 checkpoint + 自定义标题/工作空间绑定记录） */
  deleteConversation(userId: string, conversationId: string): Promise<void>

  /** 删除绑定到指定工作空间的全部会话；返回删除数量 */
  deleteConversationsByWorkspace(userId: string, workspaceId: string): Promise<number>
}
