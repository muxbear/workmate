import { initChatModel } from 'langchain'
import { ChatOpenAIResponses } from '@langchain/openai'
import type { ModelService } from '../model/ModelService'
import type { ModelRecord } from '../model/types'

export type ChatModel = Awaited<ReturnType<typeof initChatModel>>
export type ModelCredential = Pick<ModelRecord, 'id' | 'apiKey' | 'url' | 'protocol'>

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions'

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/chat\/completions$/, '')
}

/**
 * 统一构造“OpenAI 兼容端点”模型实例。
 * 这里刻意使用 modelProvider: 'openai'，避免走 @langchain/deepseek
 * 的 ChatDeepSeek 构造器，也就不会触发 DEEPSEEK_API_KEY 检查。
 */
function normalizeProtocolBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export function createModelFromCredential(
  credential: ModelCredential
): Promise<ChatModel> {
  const protocol = credential.protocol ?? 'openai-chat'
  if (protocol === 'openai-response') {
    return Promise.resolve(
      new ChatOpenAIResponses({
        model: credential.id,
        apiKey: credential.apiKey,
        configuration: { baseURL: normalizeProtocolBaseUrl(credential.url) }
      })
    ) as unknown as Promise<ChatModel>
  }
  if (protocol === 'anthropic') {
    return initChatModel(credential.id, {
      modelProvider: 'anthropic',
      apiKey: credential.apiKey,
      configuration: { baseURL: normalizeProtocolBaseUrl(credential.url) }
    })
  }
  return initChatModel(credential.id, {
    modelProvider: 'openai',
    apiKey: credential.apiKey,
    configuration: { baseURL: normalizeBaseUrl(credential.url) }
  })
}

/**
 * 解析 Agent 默认模型。
 * 1. 如果 models.json 里已经配置了同名模型，优先使用它的凭据；
 * 2. 否则退回 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL；
 * 3. 再否则退回 models.json 中的第一个自定义模型；
 * 4. 都没有时给出明确错误。
 */
export async function resolveDefaultModel(
  modelService: ModelService,
  model: string | ChatModel
): Promise<string | ChatModel> {
  if (typeof model !== 'string') return model

  const modelId = model.includes(':')
    ? model.slice(model.indexOf(':') + 1)
    : model

  const configured = modelService.getCredential(modelId)
  if (configured) return createModelFromCredential(configured)

  const envApiKey = process.env.DEEPSEEK_API_KEY
  if (envApiKey) {
    return createModelFromCredential({
      id: modelId,
      apiKey: envApiKey,
      url: process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
      protocol: 'openai-chat'
    })
  }

  const firstModel = modelService.list()[0]
  if (firstModel) return createModelFromCredential(firstModel)

  throw new Error(
    '未找到默认模型凭据：请设置 DEEPSEEK_API_KEY，或在“系统设置 -> 模型”中添加一个自定义模型。'
  )
}

/**
 * 文本类小任务（标题总结 / 改写润色）的模型解析：
 * 优先跟随当前选择的自定义模型，否则走系统默认模型链路 —— 与对话同一凭据来源，
 * 自定义端点/代理设置因此对这两条链路同样生效（历史实现 polish 直连 ChatDeepSeek 默认端点，
 * 不走用户配置）。
 */
export async function resolveUtilityModel(
  modelService: ModelService | undefined,
  customModelId?: string
): Promise<ChatModel> {
  const selectedCredential = customModelId ? modelService?.getCredential(customModelId) : undefined
  if (selectedCredential) return createModelFromCredential(selectedCredential)
  if (modelService) {
    const resolved = await resolveDefaultModel(modelService, 'deepseek:deepseek-v4-pro')
    if (typeof resolved !== 'string') return resolved
  }
  throw new Error('请先在“系统设置 -> 模型”中配置一个模型')
}
