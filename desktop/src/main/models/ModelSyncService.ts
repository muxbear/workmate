import axios, { type AxiosInstance } from 'axios'
import type { CustomModel, ModelSyncStatus, WebUser } from '../../preload/index.d'
import type { ProviderPlanType, ProviderRecord } from '../model/types'
import type { ModelService } from '../model/ModelService'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { SCOPE_MODEL_READ } from '../oauth2/scopes'

interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

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

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
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
 */
export class ModelSyncService {
  private readonly http: AxiosInstance
  private readonly authorization: OAuth2AuthorizationProvider
  private readonly modelService: ModelService

  constructor(deps: ModelSyncServiceDeps) {
    const apiBaseUrl = deps.apiBaseUrl || DEFAULT_API_BASE_URL
    this.authorization = deps.authorization
    this.modelService = deps.modelService
    this.http = axios.create({ baseURL: apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): ModelSyncStatus {
    const snapshot = this.authorization.getSnapshot(localUserId, [SCOPE_MODEL_READ])
    return {
      status: snapshot.status,
      webUser: toWebUser(snapshot.webUser)
    }
  }

  /** 确保 model:read 已授权；已授权时不打开浏览器 */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    await this.authorization.ensureAuthorization(localUserId, [SCOPE_MODEL_READ], {
      reason: 'model-sync'
    })
    return { webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  async sync(
    localUserId: string
  ): Promise<{ providerCount: number; modelCount: number; syncedAt: number }> {
    const accessToken = await this.authorization.ensureAccessToken(localUserId, [SCOPE_MODEL_READ])
    const data = await this.request<WebSyncPayload>('get', '/api/model-sync/list', undefined, {
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

  /** 断开同步：仅清理本地会话 token（决策 D1） */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
  }

  private async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    config?: Record<string, unknown>
  ): Promise<T> {
    try {
      const response =
        method === 'post'
          ? await this.http.post<WebApiEnvelope<T>>(path, body, config)
          : await this.http.get<WebApiEnvelope<T>>(path, config)
      const envelope = response.data
      if (envelope.code !== 0) {
        throw new Error(envelope.message || 'Web 服务返回错误')
      }
      return envelope.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || error.message || '网络请求失败'
        throw new Error(message)
      }
      throw error
    }
  }
}
