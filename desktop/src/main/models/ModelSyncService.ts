import type { CustomModel } from '../../shared/contracts'
import type { ProviderPlanType, ProviderRecord } from '../model/types'
import type { ModelService } from '../model/ModelService'
import type { OAuth2AuthorizationProvider } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_MODEL_READ } from '../oauth2/scopes'
import { BaseSyncService } from '../network/base-sync-service'

interface WebSyncProvider {
  id: string
  name: string
  logo: string
  defaultUrl: string
  responseUrl?: string
  anthropicUrl?: string
  plans: { type: string }[]
  models: string[]
}

interface WebSyncModel {
  id: string
  name: string
  vendor: string
  url: string
  protocol?: string
  apiKey: string
  supportsToolCall: boolean
  supportsImages: boolean
  supportsReasoning: boolean
}

interface WebSyncPayload {
  version: number
  providers: WebSyncProvider[]
  models: WebSyncModel[]
  synced_at: number
}

interface ModelSyncServiceDeps {
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  modelService: ModelService
  apiBaseUrl?: string
}

const MASKED_API_KEY = '**********'

function mapProvider(item: WebSyncProvider): ProviderRecord {
  return {
    id: item.id,
    name: item.name,
    logo: item.logo,
    defaultUrl: item.defaultUrl,
    urls: {
      openaiChat: item.defaultUrl,
      openaiResponse: item.responseUrl ?? '',
      anthropic: item.anthropicUrl ?? ''
    },
    plans: item.plans.map((plan) => ({ type: plan.type as ProviderPlanType })),
    models: item.models
  }
}

function mapModel(item: WebSyncModel): CustomModel {
  return {
    id: item.id,
    name: item.name,
    vendor: item.vendor,
    url: item.url,
    protocol: (item.protocol ?? 'openai-chat') as CustomModel['protocol'],
    apiKey: item.apiKey,
    supportsToolCall: item.supportsToolCall,
    supportsImages: item.supportsImages,
    supportsReasoning: item.supportsReasoning
  }
}

/**
 * 桌面端 Web 模型同步服务。
 *
 * 复用 OAuth2 Authorization Code + PKCE 流程，使用 model:read scope
 * 调用 /api/model-sync/list，并将结果写入 models.json。
 * 授权三件套与 HTTP 客户端由 BaseSyncService 提供；本源无进度事件（无分页、单次拉取）。
 */
export class ModelSyncService extends BaseSyncService {
  private readonly modelService: ModelService

  constructor(deps: ModelSyncServiceDeps) {
    super({
      authorization: deps.authorization,
      scopes: [SCOPE_MODEL_READ],
      reason: 'model-sync',
      apiBaseUrl: deps.apiBaseUrl
    })
    this.modelService = deps.modelService
  }

  async sync(
    localUserId: string
  ): Promise<{ providerCount: number; modelCount: number; syncedAt: number }> {
    const { accessToken } = await this.ensureSyncAccess(localUserId)
    const data = await this.http.request<WebSyncPayload>('get', '/api/model-sync/list', undefined, {
      headers: { Authorization: 'Bearer ' + accessToken }
    })

    const providers = data.providers.map(mapProvider)
    const localKeyByVendor = new Map<string, string>()
    for (const model of this.modelService.list()) {
      if (!localKeyByVendor.has(model.vendor)) {
        localKeyByVendor.set(model.vendor, model.apiKey)
      }
    }
    const models = data.models.map((item) => {
      const model = mapModel(item)
      if (model.apiKey === MASKED_API_KEY) {
        model.apiKey = localKeyByVendor.get(model.vendor) ?? model.apiKey
      }
      return model
    })
    if (models.length === 0) {
      throw new Error('服务器没有可同步的模型，本地配置未变更')
    }
    this.modelService.applySyncSnapshot({ providers, models })

    return {
      providerCount: providers.length,
      modelCount: models.length,
      syncedAt: data.synced_at
    }
  }
}
