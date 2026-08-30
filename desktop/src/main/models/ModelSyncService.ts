import axios, { type AxiosInstance } from 'axios'
import type { CustomModel, ModelSyncStatus, WebUser } from '../../preload/index.d'
import type { ProviderPlanType, ProviderRecord } from '../model/types'
import type { ISecureStorage } from '../security/secure-storage'
import type { ModelService } from '../model/ModelService'
import { OAuth2ClientService } from '../oauth2/OAuth2ClientService'

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
  secureStorage: ISecureStorage
  openExternal: (url: string) => Promise<void>
  modelService: ModelService
  apiBaseUrl?: string
  clientId?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'
const DEFAULT_CLIENT_ID = 'ke-work-desktop'
const TOKEN_KEY_PREFIX = 'model-sync:'
const MODEL_SCOPE = 'model:read'

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
  private readonly apiBaseUrl: string
  private readonly clientId: string
  private readonly oauth2: OAuth2ClientService
  private readonly modelService: ModelService

  constructor(deps: ModelSyncServiceDeps) {
    this.apiBaseUrl = deps.apiBaseUrl || DEFAULT_API_BASE_URL
    this.clientId = deps.clientId || DEFAULT_CLIENT_ID
    this.modelService = deps.modelService
    this.oauth2 = new OAuth2ClientService({
      secureStorage: deps.secureStorage,
      openExternal: deps.openExternal,
      apiBaseUrl: this.apiBaseUrl,
      clientId: this.clientId
    })
    this.http = axios.create({ baseURL: this.apiBaseUrl, timeout: 15_000 })
  }

  getStatus(localUserId: string): ModelSyncStatus {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    const scopes = (token?.scope ?? '').split(' ')
    if (!token?.accessToken || !scopes.includes(MODEL_SCOPE)) {
      return { status: 'unauthorized', webUser: token?.webUser ?? null }
    }
    return {
      status: 'authorized',
      webUser: {
        id: token.webUser?.id ?? '',
        nickname: token.webUser?.nickname ?? '',
        avatar: token.webUser?.avatar
      }
    }
  }

  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    const token = await this.oauth2.authorize(MODEL_SCOPE)
    this.oauth2.saveToken(this.tokenKey(localUserId), token)
    return { webUser: token.webUser }
  }

  async sync(
    localUserId: string
  ): Promise<{ providerCount: number; modelCount: number; syncedAt: number }> {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    const scopes = (token?.scope ?? '').split(' ')
    if (!token?.accessToken || !scopes.includes(MODEL_SCOPE)) {
      throw new Error('尚未授权模型同步权限')
    }
    const accessToken = await this.oauth2.ensureValidAccessToken(this.tokenKey(localUserId))
    const data = await this.request<WebSyncPayload>('get', '/api/model-sync/list', undefined, {
      headers: { Authorization: 'Bearer ' + accessToken }
    })

    const providers = data.providers.map(mapProvider)
    const models = data.models.map(mapModel)
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

  async disconnect(localUserId: string): Promise<void> {
    const token = this.oauth2.loadToken(this.tokenKey(localUserId))
    if (token) {
      await this.oauth2.revoke(token.refreshToken)
    }
    this.oauth2.deleteToken(this.tokenKey(localUserId))
  }

  private tokenKey(localUserId: string): string {
    return TOKEN_KEY_PREFIX + localUserId + ':tokens'
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
