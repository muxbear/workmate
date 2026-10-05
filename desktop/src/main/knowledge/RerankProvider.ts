import type { KnowledgeReranker } from './RetrievalService'
import type { KnowledgeEngineConfig } from './knowledge-config'
import { createMainHttpClient } from '../network/main-http'

/**
 * 重排（OpenAI/Cohere 兼容 `POST {baseUrl}/rerank`）。
 *
 * 契约（与「设置 → 知识库 → 嵌入与重排端点」一一对应）：
 * - `rerankBaseUrl` 或 `rerankModel` 为空 → `available() = false`，检索保留融合顺序
 *   （回传 `rerankSkipped`，UI 轻提示）；
 * - 请求体 `{ model, query, documents, top_n }`，响应兼容三种形态：
 *   cohere 平铺 `{results:[{index,relevance_score}]}`、`{output:{results}}`、`{data:[...]}`；
 * - 任何失败（超时/5xx/解析不了）都**降级为 null**，绝不因重排故障让检索不可用。
 *
 * 与向量化不同，重排是「增强层」：不做批量、不做缓存，单次 30s 超时 + 1 次瞬时错误重试。
 */

/** 重排候选上限（与检索侧候选池一致，防单次请求过大） */
const MAX_RERANK_DOCUMENTS = 50
const RERANK_TIMEOUT_MS = 30_000
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export interface RerankTransport {
  (input: {
    url: string
    headers: Record<string, string>
    body: unknown
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<unknown>
}

export interface RerankProviderDeps {
  /** 传输实现（单测注入替身；缺省走统一 HTTP 客户端） */
  transport?: RerankTransport
}

export class RerankProvider implements KnowledgeReranker {
  private readonly deps: RerankProviderDeps

  constructor(deps: RerankProviderDeps = {}) {
    this.deps = deps
  }

  available(config: KnowledgeEngineConfig): boolean {
    return Boolean(config.rerankBaseUrl.trim()) && Boolean(config.rerankModel.trim())
  }

  /** 返回与 documents 等长的相关性分数；不可用或失败返回 null（调用方降级） */
  async rerank(
    query: string,
    documents: string[],
    config: KnowledgeEngineConfig
  ): Promise<number[] | null> {
    if (!this.available(config) || !documents.length) return null
    const docs = documents.slice(0, MAX_RERANK_DOCUMENTS)
    const url = rerankUrl(config.rerankBaseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.rerankApiKey) headers.Authorization = `Bearer ${config.rerankApiKey}`
    const transport = this.deps.transport ?? defaultTransport
    const body = {
      model: config.rerankModel,
      query,
      documents: docs,
      top_n: docs.length
    }

    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        const payload = await transport({ url, headers, body, timeoutMs: RERANK_TIMEOUT_MS })
        return parseRerankPayload(payload, docs.length)
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status
        const retryable = status === undefined || RETRYABLE_STATUS.has(status)
        if (!retryable || attempt === 1) {
          console.warn('[knowledge-rerank] 重排失败，保留融合顺序：', (err as Error).message)
          return null
        }
        await delay(400)
      }
    }
    return null
  }
}

/** 默认传输：统一 HTTP 客户端（代理由 main-http 按请求注入） */
const defaultHttp = createMainHttpClient({ purpose: 'knowledge-rerank' })

const defaultTransport: RerankTransport = async ({ url, headers, body, timeoutMs }) => {
  const response = await defaultHttp.post(url, body, {
    headers,
    timeout: timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300
  })
  return response.data
}

/** baseUrl → /rerank 地址（已带 /rerank 后缀时直接用） */
export function rerankUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/rerank$/i.test(trimmed) ? trimmed : `${trimmed}/rerank`
}

/**
 * 解析三种响应形态，映射回 documents 顺序。
 * 未在结果中出现的文档得 0 分（沉底）；分数缺失按 0 处理。
 */
export function parseRerankPayload(payload: unknown, expected: number): number[] | null {
  const container = payload as {
    results?: unknown
    data?: unknown
    output?: { results?: unknown }
  }
  const raw = container?.results ?? container?.output?.results ?? container?.data
  if (!Array.isArray(raw)) throw new Error('响应缺少 results 数组')
  const scores = new Array(expected).fill(0)
  for (const item of raw as Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>) {
    const index = Number(item?.index)
    if (!Number.isInteger(index) || index < 0 || index >= expected) continue
    const score = Number(item?.relevance_score ?? item?.score ?? 0)
    scores[index] = Number.isFinite(score) ? score : 0
  }
  return scores
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
