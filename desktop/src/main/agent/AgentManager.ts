import type { DeepAgent, SubAgent } from 'deepagents'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { WorkMode } from '../mode/work-mode'
import type { ModelService } from '../model/ModelService'
import { AgentBuilder } from './AgentBuilder'
import { createModelOverrideMiddleware } from './ModelOverrideMiddleware'
import { createExpertDirectiveMiddleware } from './ExpertDirectiveMiddleware'
import { resolveDefaultModel, type ChatModel } from './ModelFactory'
import { buildKnowledgeTools, type KnowledgeToolDeps } from './tools/KnowledgeTool'
import type { McpLoadFailure } from './tools/McpToolRegistry'
import { buildExpertSubAgents } from './SubAgentFactory'
import type { McpAuthBinding } from '../oauth2/mcpAuth'
import type { DesktopExpert } from '../../shared/contracts'

/**
 * 智能体生命周期管理（单例由调用方持有）。
 *
 * 重建管线（2026-10 重构）：
 * - 所有重建（init / switchMode / setSkills / applyInstalledSkills / setExperts）收敛到
 *   唯一的 `rebuild()` 串行链，杜绝历史缺陷——并发触发在 `await` 窗口内交错写同一 builder；
 * - `buildAtomically()` 用局部 builder 构建，全部成功后**原子提交**（builder/agent/mcpWarnings/
 *   签名一起换新），失败不产生半成品状态；
 * - 配置快照签名（mode+model+skills+expertMode+专家 id@version）：不变则跳过重建（保留告警）；
 * - 专家 → SubAgent 的装配规则外移到 `SubAgentFactory`（可独立单测）。
 *
 * 生命周期状态：uninitialized → rebuilding → ready / failed（ready() 等待排队中的重建后返回）。
 */
export class AgentManager {
  private agent: DeepAgent | null = null
  private builder: AgentBuilder | null = null
  /** 重建串行链：每次重建排队执行，前一次 settle 后才开始下一次 */
  private chain: Promise<void> = Promise.resolve()
  private phase: 'uninitialized' | 'ready' | 'rebuilding' | 'failed' = 'uninitialized'
  /** init 是否已被调用（同步置位，供早期 guard 判断） */
  private started = false
  /** 最近一次成功构建的配置签名（跳过无变化重建） */
  private buildSignature = ''
  private model: string | ChatModel = 'deepseek:deepseek-v4-pro'
  private skills: string[] = []
  private experts: DesktopExpert[] = []
  private expertMode: 'selected' | 'all' = 'selected'
  /** 最近一次构建时的 MCP 加载失败信息（供调用方提示用户） */
  private mcpWarnings: McpLoadFailure[] = []
  private currentMode: WorkMode = 'local'

  constructor(
    private readonly defaultWorkspaceDir: string,
    private readonly checkpointDbPath: string,
    private readonly storeDbPath: string,
    /** 自定义模型服务（可选：测试/无自定义模型场景不注入则不注册覆盖中间件） */
    private readonly modelService?: ModelService,
    /** 技能挂载与技能 id 解析（可选；不注入时技能功能按目录名直连） */
    private readonly options: AgentManagerOptions = {}
  ) {}

  // ── 对外 API（语义与重构前一致） ──

  /** 应用启动时初始化智能体；失败信息经 ready()/日志可观察，不改变既有 fire-and-forget 用法 */
  async init(mode: WorkMode): Promise<void> {
    this.started = true
    this.currentMode = mode
    return this.rebuild('init')
  }

  /** 等待智能体就绪：先等排队中的全部重建 settle，再按当前状态返回或抛错 */
  async ready(): Promise<DeepAgent> {
    if (!this.started) throw new Error('AgentManager not initialized')
    await this.chain
    if (!this.agent || this.phase === 'failed') throw new Error('Agent not built')
    return this.agent
  }

  /** 当前 checkpointer（会话读写用；switchMode 后指向新实例） */
  getCheckpointer(): BaseCheckpointSaver {
    if (!this.builder) throw new Error('AgentManager not initialized')
    return this.builder.getCheckpointer() as BaseCheckpointSaver
  }

  /**
   * 切换工作模式：重建 backend 与记忆，保留自定义配置
   * 注：deepagents 的 DeepAgent 无 dispose/close API（资源由 backend 管理），
   * 旧实例直接丢弃，新实例在 build 时重建 checkpointer/store
   */
  async switchMode(newMode: WorkMode): Promise<void> {
    if (!this.started) throw new Error('AgentManager not initialized')
    this.currentMode = newMode
    return this.rebuild('switch-mode')
  }

  /** 设置默认模型（字符串或实例）；下次重建生效 */
  setModel(model: string | ChatModel): this {
    this.model = model
    return this
  }

  /**
   * 设置主智能体技能源。
   *
   * 入参为技能目录名（或 `/skills/<dir>/` 虚拟路径）；由自动化等按技能 id 传入时，
   * 通过 resolveSkillDirs 解析为目录名。设置后异步排队重建，调用方 await ready() 即可
   * 拿到带新技能的实例（修复此前"只写 builder 不重建"的问题）。
   */
  setSkills(skills: string[]): this {
    if (!this.started) {
      this.skills = skills
      return this
    }
    const resolve = this.options.resolveSkillDirs
    let pending: Promise<void>
    if (skills.some((skill) => !skill.startsWith('/')) && resolve) {
      pending = this.rebuild('skills', async () => {
        const dirs = await resolve(skills)
        this.skills = dirs.map((dir) => normalizeSkillPath(dir))
        if (dirs.length < skills.length) {
          console.warn(
            `[agent] ${skills.length - dirs.length}/${skills.length} 个技能 id 未能解析到本地目录，已跳过（技能可能未安装）`
          )
        }
      })
    } else {
      this.skills = skills.map((skill) => normalizeSkillPath(skill))
      pending = this.rebuild('skills')
    }
    pending.catch(() => undefined)
    return this
  }

  /** 应用已安装技能目录并重建 agent（技能页安装 / 卸载、启动恢复时调用） */
  async applyInstalledSkills(dirNames: string[]): Promise<void> {
    this.skills = dirNames.map((dir) => normalizeSkillPath(dir))
    if (!this.started) return
    return this.rebuild('skills-installed')
  }

  setExpertMode(mode: 'selected' | 'all'): this {
    this.expertMode = mode
    return this
  }

  /**
   * 设置专家并重建；调用方应 await 后再发送消息。
   * 配置签名未变（同一批同版本专家）时跳过重建并复用上次构建（告警同样复用回传）。
   *
   * @returns 本次（或上次）构建的 MCP 加载失败信息，供渲染层提示用户
   */
  async setExperts(experts: DesktopExpert[]): Promise<{ mcpWarnings: McpLoadFailure[] }> {
    this.experts = experts
    if (!this.started) return { mcpWarnings: [] }
    await this.rebuild('experts')
    return { mcpWarnings: this.mcpWarnings }
  }

  // ── 重建管线（内部） ──

  /**
   * 重建入口（唯一）：排队串行 + 可选准备步骤（如技能 id 解析）。
   * 返回的 promise 按原语义在失败时 reject；内部链已 catch（失败不毒化后续排队）。
   */
  private rebuild(reason: string, prep?: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      this.phase = 'rebuilding'
      try {
        if (prep) await prep()
        await this.buildAtomically(reason)
      } catch (err) {
        this.phase = 'failed'
        console.error(`[agent] rebuild(${reason}) failed:`, err)
        throw err
      }
    })
    // 链自愈：把本次结果降为 settled，后续 rebuild 仍可继续
    this.chain = next.catch(() => undefined)
    return next
  }

  /** 用局部 builder 构建并在末尾原子提交；配置签名不变且已有实例时跳过 */
  private async buildAtomically(reason: string): Promise<void> {
    const snapshot = {
      mode: this.currentMode,
      model: this.model,
      skills: [...this.skills],
      experts: [...this.experts],
      expertMode: this.expertMode
    }
    const signature = buildSignatureOf(snapshot)
    if (signature === this.buildSignature && this.agent) {
      this.phase = 'ready'
      return
    }

    const builder = new AgentBuilder(
      snapshot.mode,
      this.defaultWorkspaceDir,
      this.checkpointDbPath,
      this.storeDbPath,
      this.options.skillsDir
    ).withModeDefaults()

    // 关键：默认模型必须先实例化，否则会在中间件前抛错
    const model = this.modelService
      ? await resolveDefaultModel(this.modelService, snapshot.model)
      : snapshot.model
    builder.setModel(model)

    // 中间件链：
    // 1) 模型覆盖：运行期按 configurable.model_override 切换模型（无需重建 agent）
    // 2) 专家委派：选中专家的一轮向主智能体系统提示词追加强制委派指令
    //    （用户消息只保留原文；单选模式才注入，自动化全量专家模式不注入）
    const middleware: unknown[] = []
    if (this.modelService) middleware.push(createModelOverrideMiddleware(this.modelService))
    middleware.push(
      createExpertDirectiveMiddleware(() =>
        snapshot.expertMode === 'selected' ? snapshot.experts : []
      )
    )
    builder.setMiddleware(middleware)
    // 技能仅本地模式生效（云端 StoreBackend 不含本地技能目录）
    if (snapshot.skills.length > 0 && snapshot.mode === 'local') {
      builder.setSkills(snapshot.skills)
    }

    // 主智能体工具：本地知识库检索（Agentic RAG；身份在调用时从 configurable 取，失败关闭）
    if (this.options.knowledgeTools) {
      builder.setTools(buildKnowledgeTools(this.options.knowledgeTools()))
    }

    const failures: McpLoadFailure[] = []
    let subagents: SubAgent[] = []
    if (
      snapshot.experts.length > 0 &&
      (snapshot.expertMode === 'selected' || snapshot.expertMode === 'all')
    ) {
      subagents = await buildExpertSubAgents(snapshot.experts, {
        modelService: this.modelService,
        mcpAuth: this.options.mcpAuth,
        knowledgeTools: this.options.knowledgeTools?.(),
        onMcpFailure: (failure, expert) => {
          failures.push({ ...failure, toolName: `${expert.name} · ${failure.toolName}` })
        }
      })
    }
    builder.setSubagents(subagents)

    const built = await builder.build()

    // ── 原子提交（失败路径不会到达这里，不产生半成品状态）──
    this.builder = builder
    this.agent = built
    this.mcpWarnings = failures
    this.buildSignature = signature
    this.phase = 'ready'
    console.log(`[agent] rebuilt (${reason})`)
  }
}

/** 配置快照签名：mode + model + skills + expertMode + 专家 id@version 集合 */
function buildSignatureOf(snapshot: {
  mode: WorkMode
  model: string | ChatModel
  skills: string[]
  experts: DesktopExpert[]
  expertMode: string
}): string {
  const modelKey =
    typeof snapshot.model === 'string'
      ? snapshot.model
      : `obj:${String((snapshot.model as { id?: unknown }).id ?? 'custom')}`
  return JSON.stringify([
    snapshot.mode,
    modelKey,
    snapshot.skills.join('|'),
    snapshot.expertMode,
    // 版本参与签名：同步到服务端新版本后必须重建（否则子智能体沿用旧提示词/工具配置）
    snapshot.experts.map((expert) => `${expert.id}@${expert.version ?? ''}`).join(',')
  ])
}

/** 技能引用归一化为 backend 虚拟路径（/skills/<dir>/） */
function normalizeSkillPath(value: string): string {
  if (value.startsWith('/')) return value.endsWith('/') ? value : `${value}/`
  return `/skills/${value}/`
}

/** AgentManager 可选扩展（技能挂载、技能 id 解析与 MCP 凭据） */
export interface AgentManagerOptions {
  /** 本地技能根目录（~/.ke-work/skills）；提供后本地模式挂载 /skills/ 路由 */
  skillsDir?: string
  /** 技能 id → 本地目录名解析器（自动化任务按 id 引用技能时使用） */
  resolveSkillDirs?: (ids: string[]) => Promise<string[]>
  /** MCP 凭据绑定：专家同步下来的平台内 MCP 服务需要它才能带上 OAuth2 token */
  mcpAuth?: McpAuthBinding
  /**
   * 本地知识库检索（提供后主智能体获得 kb_search / list_knowledge_bases 工具）。
   * 用工厂而不是实例：知识库服务晚于 AgentManager 构造（避免启动顺序耦合）。
   */
  knowledgeTools?: () => KnowledgeToolDeps
}
