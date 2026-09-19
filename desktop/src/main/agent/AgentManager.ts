import type { DeepAgent, SubAgent } from 'deepagents'
import type { DesktopExpert } from '../../preload/index.d'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { WorkMode } from '../mode/work-mode'
import type { ModelService } from '../model/ModelService'
import { AgentBuilder } from './AgentBuilder'
import { createModelOverrideMiddleware } from './ModelOverrideMiddleware'
import { createModelFromCredential, resolveDefaultModel, type ChatModel } from './ModelFactory'
import { buildExpertTools, buildExpertSkills } from './tools/DesktopToolRegistry'
import { buildExpertMcpTools } from './tools/McpToolRegistry'

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
  modelService?: ModelService
): Promise<SubAgent> {
  return {
    name: expert.name,
    description: buildExpertDescription(expert),
    systemPrompt: expert.systemPrompt || '',
    model: await resolveExpertModel(expert, modelService),
    tools: [
      ...buildExpertTools(expert.tools, modelService, expert.modelName),
      ...(await buildExpertMcpTools(expert.mcpConfigs))
    ],
    skills: buildExpertSkills(expert.skills)
  }
}

/** 技能引用归一化为 backend 虚拟路径（/skills/<dir>/） */
function normalizeSkillPath(value: string): string {
  if (value.startsWith('/')) return value.endsWith('/') ? value : `${value}/`
  return `/skills/${value}/`
}

/** AgentManager 可选扩展（技能挂载与技能 id 解析） */
export interface AgentManagerOptions {
  /** 本地技能根目录（~/.ke-work/skills）；提供后本地模式挂载 /skills/ 路由 */
  skillsDir?: string
  /** 技能 id → 本地目录名解析器（自动化任务按 id 引用技能时使用） */
  resolveSkillDirs?: (ids: string[]) => Promise<string[]>
}

export class AgentManager {
  private agent: DeepAgent | null = null
  private builder: AgentBuilder | null = null
  private initPromise: Promise<void> | null = null
  private model: string | ChatModel = 'deepseek:deepseek-v4-pro'
  private skills: string[] = []
  private experts: DesktopExpert[] = []
  private expertMode: 'selected' | 'all' = 'selected'
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
    // 自定义模型覆盖中间件：运行期按 configurable.model_override 切换模型（无需重建 agent）
    if (this.modelService)
      this.builder.setMiddleware([createModelOverrideMiddleware(this.modelService)])
    // 技能仅本地模式生效（云端 StoreBackend 不含本地技能目录）
    if (this.skills.length > 0 && mode === 'local') this.builder.setSkills(this.skills)

    if (this.experts.length > 0 && (this.expertMode === 'selected' || this.expertMode === 'all')) {
      this.builder.setSubagents(
        await Promise.all(this.experts.map((expert) => expertToSubAgent(expert, this.modelService)))
      )
    } else {
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

  /** 设置专家并重建 agent；调用方必须 await 后再发送消息。 */
  async setExperts(experts: DesktopExpert[]): Promise<void> {
    this.experts = experts
    if (!this.builder) throw new Error('AgentManager not initialized')
    this.initPromise = this.buildAgent(this.currentMode)
    await this.initPromise
  }
}
