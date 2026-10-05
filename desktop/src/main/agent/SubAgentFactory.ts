import type { SubAgent } from 'deepagents'
import type { DesktopExpert } from '../../shared/contracts'
import type { ModelService } from '../model/ModelService'
import { createModelFromCredential, type ChatModel } from './ModelFactory'
import { buildExpertTools, buildExpertSkills } from './tools/DesktopToolRegistry'
import type { KnowledgeToolDeps } from './tools/KnowledgeTool'
import { buildExpertMcpTools, type McpLoadFailure } from './tools/McpToolRegistry'
import type { McpAuthBinding } from '../oauth2/mcpAuth'

/**
 * 专家 → DeepAgents SubAgent 装配工厂（自 AgentManager 外移，可独立测试）。
 *
 * 装配步骤固定：内置工具 → MCP 工具（按请求现取凭据）→ 同名去重（内置优先）→
 * 描述/提示词/模型/技能。AgentManager 只负责编排与提交，不再承载装配规则。
 */

/** 将桌面版专家数据转换为子智能体描述（供主智能体做委派判断；纯函数便于单测） */
export function buildExpertDescription(expert: DesktopExpert): string {
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

export interface SubAgentFactoryDeps {
  modelService?: ModelService
  /** MCP 凭据绑定：平台内 MCP 服务需要它才能带上 OAuth2 token */
  mcpAuth?: McpAuthBinding
  /** 本地知识库检索工具依赖（专家工具集里带知识库能力时使用） */
  knowledgeTools?: KnowledgeToolDeps
  /** MCP 加载失败回调（AgentManager 聚合为 mcpWarnings 供渲染层提示；携带专家便于加前缀定位） */
  onMcpFailure?: (failure: McpLoadFailure, expert: DesktopExpert) => void
}

/** 单个专家 → SubAgent */
export async function buildSubAgentForExpert(
  expert: DesktopExpert,
  deps: SubAgentFactoryDeps
): Promise<SubAgent> {
  const builtinTools = buildExpertTools(
    expert.tools,
    deps.modelService,
    expert.modelName,
    expert.capabilities ?? [],
    { knowledge: deps.knowledgeTools }
  )
  const mcpTools = await buildExpertMcpTools(expert.mcpConfigs, {
    onError: deps.onMcpFailure ? (failure) => deps.onMcpFailure!(failure, expert) : undefined,
    mcpAuth: deps.mcpAuth
  })
  // 同名工具只保留内置那一份：本地 kb_search 与「云知识库检索」MCP 服务同名，
  // 两份同时挂会让模型撞名（内置优先 = 本地库可直接用，云库仍可换名/另一专家挂载）
  const builtinNames = new Set(builtinTools.map((tool) => tool.name))
  return {
    name: expert.name,
    description: buildExpertDescription(expert),
    systemPrompt: expert.systemPrompt || '',
    model: await resolveExpertModel(expert, deps.modelService),
    tools: [...builtinTools, ...mcpTools.filter((tool) => !builtinNames.has(tool.name))],
    skills: buildExpertSkills(expert.skills)
  }
}

/** 批量构建（并发），失败信息经 onMcpFailure 汇总 */
export async function buildExpertSubAgents(
  experts: DesktopExpert[],
  deps: SubAgentFactoryDeps
): Promise<SubAgent[]> {
  return Promise.all(experts.map((expert) => buildSubAgentForExpert(expert, deps)))
}
