import { randomUUID } from 'crypto'
import { HumanMessage } from '@langchain/core/messages'
import type { DesktopExpert } from '../../preload/index.d'
import type { AgentManager } from '../agent/AgentManager'
import { invokeSendMessage, toLangChainMessages } from '../agent/service'
import { expandFileParts } from '../agent/file-parts'
import type { ConversationStore } from '../agent/ConversationStore'
import type { ModelService } from '../model/ModelService'
import type { WorkspaceService } from '../workspace/WorkspaceService'
import type { AutomationRepository } from './AutomationRepository'
import type { AutomationRunRepository } from './AutomationRunRepository'
import type { AutomationService } from './AutomationService'
import type { AutomationTaskRecord, RunErrorCode, RunStatus, RunTrigger } from './types'

/** 单次执行超时（毫秒） */
const RUN_TIMEOUT_MS = 10 * 60 * 1000
/** 输出摘要落库长度上限 */
const OUTPUT_PREVIEW_LIMIT = 2000

/** 带错误分类的业务异常 */
class RunnerError extends Error {
  constructor(
    readonly code: RunErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** 把执行异常归类为可展示的失败原因 */
function classifyError(err: unknown): { code: RunErrorCode; message: string } {
  if (err instanceof RunnerError) return { code: err.code, message: err.message }
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'timeout', message: '执行超时，已中断' }
  }
  if (message.indexOf('DEEPSEEK_API_KEY') >= 0 || message.indexOf('默认模型凭据') >= 0) {
    return { code: 'model_not_configured', message }
  }
  if (
    message.indexOf('ENOENT') >= 0 ||
    message.indexOf('文件不存在') >= 0 ||
    message.indexOf('不是文件') >= 0
  ) {
    return { code: 'file_missing', message }
  }
  if (message.indexOf('工作空间') >= 0) {
    return { code: 'workspace_unavailable', message }
  }
  return { code: 'agent_error', message }
}

export interface AutomationRunnerDeps {
  tasks: AutomationRepository
  runs: AutomationRunRepository
  service: AutomationService
  conversationStore: ConversationStore
  workspaceService: WorkspaceService
  modelService: ModelService
  /** 专用 Agent 管理器（与交互式会话隔离） */
  agentManager: AgentManager
  /** 专家定义来源（缺省时任务不注入专家） */
  resolveExperts?: () => Promise<DesktopExpert[]>
  /** 事件广播：渲染层据此刷新任务列表与运行记录 */
  broadcast?: (channel: string, payload: unknown) => void
  /** 运行完成通知（由主进程按通知设置决定是否真正弹出） */
  notify?: (payload: { taskId: string; title: string; status: RunStatus; message: string }) => void
}

/**
 * 自动化执行器
 *
 * 单次运行：推后排期 → 建运行记录 → 组装会话与消息 → 调 Agent → 落库结果并重排期。
 * 无窗口执行：invokeSendMessage 传 null 窗口，用 onToken 汇总输出。
 */
export class AutomationRunner {
  constructor(private readonly deps: AutomationRunnerDeps) {}

  /** 执行一个任务（调度触发 / 手动立即运行 / 重试） */
  async run(
    task: AutomationTaskRecord,
    trigger: RunTrigger,
    opts?: { scheduledAt?: number | null }
  ): Promise<{ runId: string }> {
    const startedAt = Date.now()
    // 先推后排期，避免长时间运行期间被重复触发
    this.deps.service.scheduleTask(task, startedAt)

    const run = this.deps.runs.createRun({
      taskId: task.id,
      userId: task.userId,
      trigger,
      scheduledAt: opts?.scheduledAt ?? null,
      startedAt
    })
    this.deps.broadcast?.('automation:changed', {
      taskId: task.id,
      runId: run.id,
      phase: 'started'
    })

    let output = ''
    let status: RunStatus = 'success'
    let errorCode: RunErrorCode | null = null
    let errorMessage: string | null = null
    let threadId: string | null = null
    let artifacts: unknown[] = []

    try {
      // 模型来自「设置 - 模型」：按 id / 名称解析成 modelOverride；Auto 或未指定走默认模型
      const modelOverride = this.resolveModelOverride(task)
      if (task.model && task.model !== 'Auto' && !modelOverride) {
        throw new RunnerError(
          'model_not_configured',
          '任务选择的模型「' + task.model + '」在设置 - 模型中不可用，请重新配置'
        )
      }

      const conversationId = task.id
      threadId = this.deps.conversationStore.buildThreadId(task.userId, conversationId)
      const history = await this.deps.conversationStore.getRawMessages(task.userId, task.id)
      const messages = toLangChainMessages(history)
      const blocks = await expandFileParts(task.promptParts)
      messages.push(new HumanMessage({ id: 'msg-' + randomUUID(), content: blocks }))

      const ws = this.resolveWorkspace(task)
      if (ws) this.deps.conversationStore.bindWorkspace(task.userId, conversationId, ws)

      const expert = await this.resolveExpert(task.expertId)
      await this.deps.agentManager.setExperts(expert ? [expert] : [])
      this.deps.agentManager.setSkills(task.skillIds)
      const agent = await this.deps.agentManager.ready()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
      try {
        await invokeSendMessage(
          messages,
          null,
          agent,
          {
            thread_id: threadId,
            user_id: task.userId,
            workspace_dir: ws?.dir,
            workspace: ws,
            ...(modelOverride ? { modelOverride } : {})
          },
          controller.signal,
          (list) => {
            artifacts = list
          },
          (text) => {
            output += text
          }
        )
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      const classified = classifyError(err)
      status = 'failed'
      errorCode = classified.code
      errorMessage = classified.message
    }

    const finishedAt = Date.now()
    this.deps.runs.finishRun(run.id, {
      status,
      finishedAt,
      durationMs: finishedAt - startedAt,
      outputPreview: output ? output.slice(0, OUTPUT_PREVIEW_LIMIT) : null,
      errorCode,
      errorMessage,
      artifacts
    })
    this.deps.tasks.bumpRunCounters(task.id, status === 'success', status, finishedAt)

    // 重排下一次触发（任务可能在运行期间被暂停 / 删除）
    const fresh = this.deps.tasks.getById(task.userId, task.id)
    if (fresh) this.deps.service.scheduleTask(fresh, finishedAt)

    this.deps.broadcast?.('automation:changed', {
      taskId: task.id,
      runId: run.id,
      phase: 'finished',
      status
    })
    this.deps.notify?.({
      taskId: task.id,
      title: task.title,
      status,
      message: status === 'success' ? '运行完成' : errorMessage || '运行失败'
    })

    return { runId: run.id }
  }

  /** 解析任务选择的模型：优先自定义模型 id，其次按名称匹配「设置-模型」中的模型；Auto 走默认模型 */
  private resolveModelOverride(task: AutomationTaskRecord): string | undefined {
    const candidates: string[] = []
    if (task.customModelId) candidates.push(task.customModelId)
    if (task.model) candidates.push(task.model)
    for (const key of candidates) {
      if (key === 'Auto') continue
      if (this.deps.modelService.getCredential(key)) return key
      const matched = this.deps.modelService
        .list()
        .find((item) => item.name === key && this.deps.modelService.getCredential(item.id))
      if (matched) return matched.id
    }
    return undefined
  }

  /** 解析任务绑定的工作空间；目录被删除时返回 null，运行继续（走默认目录） */
  private resolveWorkspace(
    task: AutomationTaskRecord
  ): { id: string; name: string; dir: string } | null {
    if (!task.workspaceId) return null
    try {
      return this.deps.workspaceService.resolveWorkspace(task.workspaceId, task.userId)
    } catch {
      return null
    }
  }

  /** 解析任务专家定义（来源为本地专家文件，找不到时返回 null） */
  private async resolveExpert(expertId: string | null): Promise<DesktopExpert | null> {
    if (!expertId || !this.deps.resolveExperts) return null
    try {
      const list = await this.deps.resolveExperts()
      return list.find((item) => item.id === expertId) ?? null
    } catch {
      return null
    }
  }
}
