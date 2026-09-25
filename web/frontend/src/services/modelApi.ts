/**
 * Model API — 模型管理接口
 */
import instance from './request'
import type { Provider, AIModel, ModelParam, ModelTypeOption } from '@/types/model'

/* ------------------------------------------------------------------ */
/*  snake_case ↔ camelCase 转换                                       */
/* ------------------------------------------------------------------ */

function toModelParam(raw: Record<string, unknown>): ModelParam {
  return {
    key: raw.key as string,
    label: raw.label as string,
    value: raw.value as number | string,
    min: raw.min as number | undefined,
    max: raw.max as number | undefined,
    step: raw.step as number | undefined,
    type: raw.type as 'number' | 'text' | 'select',
    options: raw.options as string[] | undefined,
  }
}

function toModel(raw: Record<string, unknown>): AIModel {
  return {
    id: raw.id as string,
    name: raw.name as string,
    displayName: raw.display_name as string,
    type: raw.type as AIModel['type'],
    status: raw.status as AIModel['status'],
    contextWindow: raw.context_window as number | undefined,
    maxInputTokens: raw.max_input_tokens as number | undefined,
    maxOutputTokens: raw.max_output_tokens as number | undefined,
    dim: raw.dim as number | undefined,
    rpm: raw.rpm as number | undefined,
    tpm: raw.tpm as number | undefined,
    apiBase: (raw.api_base as string) ?? undefined,
    callCount: (raw.call_count as number) ?? 0,
    params: ((raw.params as Record<string, unknown>[]) ?? []).map(toModelParam),
    description: (raw.description as string) ?? '',
    releaseDate: raw.release_date as string | undefined,
    sortOrder: raw.sort_order as number | undefined,
    isDefault: (raw.is_default as boolean) ?? false,
  }
}

function toProvider(raw: Record<string, unknown>): Provider {
  return {
    id: raw.id as string,
    name: raw.name as string,
    logo: raw.logo as string,
    status: raw.status as Provider['status'],
    apiBase: raw.api_base as string,
    responseUrl: raw.response_url as string,
    anthropicUrl: raw.anthropic_url as string,
    apiKey: raw.api_key as string,
    models: ((raw.models as Record<string, unknown>[]) ?? []).map(toModel),
    description: (raw.description as string) ?? '',
    website: (raw.website as string) ?? '',
    sortOrder: raw.sort_order as number | undefined,
  }
}

function toModelPayload(data: AIModel): Record<string, unknown> {
  return {
    name: data.name,
    display_name: data.displayName,
    type: data.type,
    status: data.status,
    context_window: data.contextWindow ?? null,
    max_input_tokens: data.maxInputTokens ?? null,
    max_output_tokens: data.maxOutputTokens ?? null,
    dim: data.dim ?? null,
    rpm: data.rpm ?? null,
    tpm: data.tpm ?? null,
    api_base: data.apiBase?.trim() ? data.apiBase.trim() : null,
    call_count: data.callCount,
    description: data.description,
    release_date: data.releaseDate ?? null,
    params: data.params,
  }
}

function toProviderPayload(data: Provider): Record<string, unknown> {
  return {
    name: data.name,
    logo: data.logo,
    api_base: data.apiBase,
    response_url: data.responseUrl,
    anthropic_url: data.anthropicUrl,
    api_key: data.apiKey,
    status: data.status,
    description: data.description,
    website: data.website,
  }
}

/* ------------------------------------------------------------------ */
/*  API 函数                                                           */
/* ------------------------------------------------------------------ */

export async function fetchProviders(): Promise<Provider[]> {
  const res = await instance.get('/providers')
  return (res.data.data as Record<string, unknown>[]).map(toProvider)
}

/**
 * 获取可选的模型类型。
 *
 * 取值来自「参数配置」页面的 `model_type` 分组；后端在未配置时回退到内置列表，
 * 因此这里不会返回空数组。
 */
export async function fetchModelTypes(): Promise<ModelTypeOption[]> {
  const res = await instance.get('/providers/model-types')
  return ((res.data.data as Record<string, unknown>[]) ?? []).map((raw) => ({
    value: String(raw.value ?? ''),
    label: String(raw.label ?? raw.value ?? ''),
  }))
}

export async function createProvider(data: Provider): Promise<Provider> {
  const res = await instance.post('/providers', toProviderPayload(data))
  return toProvider(res.data.data as Record<string, unknown>)
}

export async function updateProvider(id: string, data: Provider): Promise<Provider> {
  const res = await instance.put(`/providers/${id}`, toProviderPayload(data))
  return toProvider(res.data.data as Record<string, unknown>)
}

export async function deleteProvider(id: string): Promise<void> {
  await instance.delete(`/providers/${id}`)
}

export async function reorderProviders(providerIds: string[]): Promise<void> {
  await instance.patch('/providers/reorder', { provider_ids: providerIds })
}

export async function createModel(providerId: string, data: AIModel): Promise<AIModel> {
  const res = await instance.post(`/providers/${providerId}/models`, toModelPayload(data))
  return toModel(res.data.data as Record<string, unknown>)
}

export async function updateModel(
  providerId: string,
  modelId: string,
  data: AIModel,
): Promise<AIModel> {
  const res = await instance.put(`/providers/${providerId}/models/${modelId}`, toModelPayload(data))
  return toModel(res.data.data as Record<string, unknown>)
}

export async function deleteModel(providerId: string, modelId: string): Promise<void> {
  await instance.delete(`/providers/${providerId}/models/${modelId}`)
}

export async function cloneModel(providerId: string, modelId: string): Promise<AIModel> {
  const res = await instance.post(`/providers/${providerId}/models/${modelId}/clone`)
  return toModel(res.data.data as Record<string, unknown>)
}

export async function reorderModels(providerId: string, modelIds: string[]): Promise<void> {
  await instance.patch(`/providers/${providerId}/models/reorder`, { model_ids: modelIds })
}

export async function toggleModelStatus(providerId: string, modelId: string): Promise<AIModel> {
  const res = await instance.patch(`/providers/${providerId}/models/${modelId}/status`)
  return toModel(res.data.data as Record<string, unknown>)
}

/** 将模型设为全局默认对话模型（全局唯一，后端会清空其它模型的标记）。 */
export async function setDefaultModel(providerId: string, modelId: string): Promise<AIModel> {
  const res = await instance.patch(`/providers/${providerId}/models/${modelId}/default`)
  return toModel(res.data.data as Record<string, unknown>)
}
