import type { DeepAgent, SubAgent } from 'deepagents'
import type { DesktopExpert } from '../../preload/index.d'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { WorkMode } from '../mode/work-mode'
import type { ModelService } from '../model/ModelService'
import { AgentBuilder } from './AgentBuilder'
import { createModelOverrideMiddleware } from './ModelOverrideMiddleware'
import { createExpertDirectiveMiddleware } from './ExpertDirectiveMiddleware'
import { createModelFromCredential, resolveDefaultModel, type ChatModel } from './ModelFactory'
import { buildExpertTools, buildExpertSkills } from './tools/DesktopToolRegistry'
import { buildKnowledgeTools, type KnowledgeToolDeps } from './tools/KnowledgeTool'
import { buildExpertMcpTools, type McpLoadFailure } from './tools/McpToolRegistry'
import type { McpAuthBinding } from '../oauth2/mcpAuth'

/** 智能体生命周期管理（单例由调用方持有） */
/** 将桌面版专家数据转换为 DeepAgents SubAgent 配置。 */
function buildExpertDescription(expert: DesktopExpert): string {
  const expertise = expert.expertiseAreas.length
    ? expert.expertiseAreas.join('、')
    : expert.desc || '无'
  const tags = expert.tags.length ? expert.tags.join('、') : '通用任务'
  const tools = expert.tools.length ? expert.tools.join('、') : '无专用工具'
  const mcpToolNames = (expert.mcpConfigs ?? [])
    .filter((cfg) => cfg.enabled && cfg.mcpToolName)
    .map((cfg) => cfg.mcpToolName)
  const toolText =
    mcpToolNames.length > 0 ? tools + '（MCP 工具：' + mcpToolNames.join('、') + '）' : tools
  return [
    expert.name + '：' + expert.title + '。',
    '专长领域：' + expertise + '。',
    '适用场景：当任务涉及' + tags + '时应优先委派。',
    '可用工具：' + toolText
  ].join('')
}

async function resolveExpertModel(
  expert: DesktopExpert,
  modelService?: ModelService
): Promise<ChatModel | undefined> {
  if (expert.modelType === 'image-gen') return undefined
  if (!modelService) return undefined
  const modelId = expert.modelName || expert.modelId || undefined
  if (!modelId) return undefined
  const credential = modelService.getCredential(modelId)
  return credential ? await createModelFromCredential(credential) : undefined
}

async function expertToSubAgent(
  expert: DesktopExpert,
  modelService?: ModelService,
  onMcpError?: (failure: McpLoadFailure) => void,
  mcpAuth?: McpAuthBinding,
  knowledgeTools?: KnowledgeToolDeps
): Promise<SubAgent> {
  const builtinTools = buildExpertTools(
    expert.tools,
    modelService,
    expert.modelName,
    expert.capabilities ?? [],
    { knowledge: knowledgeTools }
  )
  const mcpTools = await buildExpertMcpTools(expert.mcpConfigs, { onError: onMcpError, mcpAuth })
  // 同名工具只保留内置那一份：本地 kb_search 与「云知识库检索」MCP 服务同名，
  // 两份同时挂会让模型撞名（内置优先 = 本地库可直接用，云库仍可换名/另一专家挂载）
  const builtinNames = new Set(builtinTools.map((tool) => tool.name))
  return {
    name: expert.name,
    description: buildExpertDescription(expert),
    systemPrompt: expert.systemPrompt || '',
    model: await resolveExpertModel(expert, modelService),
    tools: [...builtinTools, ...mcpTools.filter((tool) => !builtinNames.has(tool.name))],
    skills: buildExpertSkills(expert.skills)
  }
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

export class AgentManager {
  private agent: DeepAgent | null = null
  private builder: AgentBuilder | null = null
  private initPromise: Promise<void> | null = null
  private model: string | ChatModel = 'deepseek:deepseek-v4-pro'
  private skills: string[] = []
  private experts: DesktopExpert[] = []
  private expertMode: 'selected' | 'all' = 'selected'
  /** 最近一次构建时的 MCP 加载失败信息（供调用方提示用户） */
  private mcpWarnings: McpLoadFailure[] = []
  /** 专家集合签名（id 排序拼接）：集合未变化时复用已构建的 agent，避免每轮重建 */
  private expertSignature = ''
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

  /** 应用启动时初始化智能体（保存 promise，供 ready() 复用） */
  async init(mode: WorkMode): Promise<void> {
    this.currentMode = mode
    this.initPromise = this.buildAgent(mode)
    return this.initPromise
  }

  private async buildAgent(mode: WorkMode): Promise<void> {
    this.builder = new AgentBuilder(
      mode,
      this.defaultWorkspaceDir,
      this.checkpointDbPath,
      this.storeDbPath,
      this.options.skillsDir
    ).withModeDefaults()

    // 关键：默认模型必须先实例化，否则会像现在一样在中间件前抛错。
    const model = this.modelService
      ? await resolveDefaultModel(this.modelService, this.model)
      : this.model

    this.builder.setModel(model)
    // 中间件链：
    // 1) 模型覆盖：运行期按 configurable.model_override 切换模型（无需重建 agent）
    // 2) 专家委派：选中专家的一轮向主智能体系统提示词追加强制委派指令
    //    （用户消息只保留原文；单选模式才注入，自动化全量专家模式不注入）
    const middleware: unknown[] = []
    if (this.modelService) middleware.push(createModelOverrideMiddleware(this.modelService))
    middleware.push(
      createExpertDirectiveMiddleware(() => (this.expertMode === 'selected' ? this.experts : []))
    )
    this.builder.setMiddleware(middleware)
    // 技能仅本地模式生效（云端 StoreBackend 不含本地技能目录）
    if (this.skills.length > 0 && mode === 'local') this.builder.setSkills(this.skills)

    // 主智能体工具：本地知识库检索（Agentic RAG；身份在调用时从 configurable 取，失败关闭）
    if (this.options.knowledgeTools) {
      this.builder.setTools(buildKnowledgeTools(this.options.knowledgeTools()))
    }

    if (this.experts.length > 0 && (this.expertMode === 'selected' || this.expertMode === 'all')) {
      const failures: McpLoadFailure[] = []
      const subagents = await Promise.all(
        this.experts.map((expert) =>
          expertToSubAgent(
            expert,
            this.modelService,
            (failure) => {
              failures.push({ ...failure, toolName: `${expert.name} · ${failure.toolName}` })
            },
            this.options.mcpAuth,
            this.options.knowledgeTools?.()
          )
        )
      )
      this.mcpWarnings = failures
      this.builder.setSubagents(subagents)
    } else {
      this.mcpWarnings = []
      this.builder.setSubagents([])
    }

    this.agent = await this.builder.build()
  }

  /** 等待智能体就绪（agent:send 前 await；init 失败时抛错） */
  async ready(): Promise<DeepAgent> {
    if (!this.initPromise) throw new Error('AgentManager not initialized')
    await this.initPromise
    if (!this.agent) throw new Error('Agent not built')
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
    if (!this.builder) throw new Error('AgentManager not initialized')
    this.currentMode = newMode
    this.initPromise = this.buildAgent(newMode)
    await this.initPromise
  }

  setModel(model: string | ChatModel): this {
    this.model = model
    this.builder?.setModel(model)
    return this
  }

  /**
   * 设置主智能体技能源。
   *
   * 入参为技能目录名（或 `/skills/<dir>/` 虚拟路径）；由自动化等按技能 id 传入时，
   * 通过 resolveSkillDirs 解析为目录名。设置后异步重建 agent，调用方 await ready()
   * 即可拿到带新技能的实例（修复此前只写 builder 不重建的问题）。
   */
  setSkills(skills: string[]): this {
    if (!this.builder) {
      this.skills = skills
      return this
    }
    const resolve = this.options.resolveSkillDirs
    if (skills.some((skill) => !skill.startsWith('/')) && resolve) {
      this.initPromise = (async () => {
        const dirs = await resolve(skills)
        this.skills = dirs.map((dir) => normalizeSkillPath(dir))
        if (dirs.length < skills.length) {
          console.warn(
            `[agent] ${skills.length - dirs.length}/${skills.length} 个技能 id 未能解析到本地目录，已跳过（技能可能未安装）`
          )
        }
        await this.buildAgent(this.currentMode)
      })()
    } else {
      this.skills = skills.map((skill) => normalizeSkillPath(skill))
      this.initPromise = this.buildAgent(this.currentMode)
    }
    const pending = this.initPromise
    if (pending) pending.catch(() => undefined)
    return this
  }

  /** 应用已安装技能目录并重建 agent（技能页安装 / 卸载、启动恢复时调用） */
  async applyInstalledSkills(dirNames: string[]): Promise<void> {
    this.skills = dirNames.map((dir) => normalizeSkillPath(dir))
    if (!this.builder) return
    this.initPromise = this.buildAgent(this.currentMode)
    await this.initPromise
  }

  setExpertMode(mode: 'selected' | 'all'): this {
    this.expertMode = mode
    return this
  }

  /**
   * 设置专家并重建 agent；调用方必须 await 后再发送消息。
   *
   * @returns 本次（或上次构建）的 MCP 加载失败信息，供渲染层提示用户
   */
  async setExperts(experts: DesktopExpert[]): Promise<{ mcpWarnings: McpLoadFailure[] }> {
    // 签名含版本号：专家 id 不变但版本更新（同步到服务端新版本）时必须重建，
    // 否则子智能体会一直沿用旧版提示词/工具配置
    const signature = experts
      .map((expert) => `${expert.id}@${expert.version ?? ''}`)
      .sort()
      .join(',')
    this.experts = experts
    if (signature === this.expertSignature && this.agent) {
      // 同一批专家（例如同一会话连续多轮对话）：跳过重建，省下 agent/checkpointer 重建开销
      return { mcpWarnings: this.mcpWarnings }
    }
    if (!this.builder) throw new Error('AgentManager not initialized')
    this.expertSignature = signature
    this.initPromise = this.buildAgent(this.currentMode)
    await this.initPromise
    return { mcpWarnings: this.mcpWarnings }
  }
}
