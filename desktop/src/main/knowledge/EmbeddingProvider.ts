import { createHash } from 'crypto'
import type { KnowledgeEmbedder } from './KnowledgeIndexService'
import type { KnowledgeEngineConfig } from './knowledge-config'
import { createMainHttpClient } from '../network/main-http'

/**
 * 向量化（OpenAI 兼容 `POST {baseUrl}/embeddings`）。
 *
 * 契约（与「设置 → 知识库 → 嵌入与重排端点」一一对应）：
 * - `embeddingBaseUrl` 为空 → `available() = false`，索引走纯稀疏链路、检索降级关键词模式；
 * - 模型名取生效配置的 `embeddingModel`（按库可覆盖），维度取 `vectorDimensions`；
 * - 返回向量统一做 **L2 归一化**后入库（vec0 是 L2 距离，检索侧用 `cos = 1 - d²/2` 换算；
 *   JS 降级路径用点积即余弦）；
 * - 维度校验：返回长度 ≠ 配置维度 → 抛错（该文档 failed，不写半截向量）。
 *
 * 可靠性与成本：
 * - 32 条/批、单批 60s 超时、408/429/5xx 指数退避重试 2 次；
 * - 命中 `knowledge_embedding_cache`（sha1(model|dim|text)）直接复用，重建索引不再重复计费；
 * - 同批内重复文本只请求一次；
 * - 代理由统一 HTTP 客户端（network/main-http，R8-5）按请求注入，与「设置 → 网络」同源。
 */

/** 批次大小（与设计文档一致） */
const EMBED_BATCH_SIZE = 32
/** 单批超时 */
const EMBED_BATCH_TIMEOUT_MS = 60_000
/** 可重试的 HTTP 状态（限流/服务端抖动） */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const MAX_RETRIES = 2

/** 一次 embeddings 请求（可注入替身做单测） */
export interface EmbeddingTransport {
  (input: {
    url: string
    headers: Record<string, string>
    body: unknown
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<unknown>
}

/**
 * 向量缓存的最小依赖（KnowledgeStore 天然满足）。
 * 收窄接口让本模块的单元测试不必拉起 better-sqlite3（也就免了 ABI 切换）。
 */
export interface EmbeddingCacheStore {
  getEmbeddingCache: (hashes: string[]) => Map<string, Float32Array>
  putEmbeddingCache: (entries: Array<{ hash: string; dim: number; vector: Float32Array }>) => void
}

export interface EmbeddingProviderDeps {
  store: EmbeddingCacheStore
  /** 传输实现（单测注入替身；缺省走统一 HTTP 客户端） */
  transport?: EmbeddingTransport
}

export class EmbeddingProvider implements KnowledgeEmbedder {
  private readonly deps: EmbeddingProviderDeps

  constructor(deps: EmbeddingProviderDeps) {
    this.deps = deps
  }

  /** 端点与模型齐备才可用（维度由 schema 限定为 1024/1536/3072） */
  available(config: KnowledgeEngineConfig): boolean {
    return (
      Boolean(config.embeddingBaseUrl.trim()) &&
      Boolean(config.embeddingModel.trim()) &&
      config.vectorDimensions > 0
    )
  }

  /**
   * 批量向量化（顺序、按批；返回与入参等长且同序）。
   * `signal` 用于索引取消：批次之间与请求内部都会检查。
   */
  async embed(
    texts: string[],
    config: KnowledgeEngineConfig,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    if (!this.available(config)) throw new Error('嵌入端点未配置')
    const vectors: Float32Array[] = new Array(texts.length)

    // 1. 缓存命中（同一文本在不同文档/重建之间复用）
    const hashes = texts.map((text) =>
      embeddingHash(config.embeddingModel, config.vectorDimensions, text)
    )
    const cached = this.deps.store.getEmbeddingCache(hashes)
    const pendingIndexes: number[] = []
    texts.forEach((_, index) => {
      const hit = cached.get(hashes[index])
      if (hit && hit.length === config.vectorDimensions) vectors[index] = hit
      else pendingIndexes.push(index)
    })
    if (!pendingIndexes.length) return vectors

    // 2. 未命中部分去重后分批请求
    const uniqueTexts: string[] = []
    const textToIndexes = new Map<string, number[]>()
    for (const index of pendingIndexes) {
      const text = texts[index]
      const list = textToIndexes.get(text)
      if (list) {
        list.push(index)
      } else {
        textToIndexes.set(text, [index])
        uniqueTexts.push(text)
      }
    }

    for (let offset = 0; offset < uniqueTexts.length; offset += EMBED_BATCH_SIZE) {
      throwIfAborted(signal)
      const batch = uniqueTexts.slice(offset, offset + EMBED_BATCH_SIZE)
      const batchVectors = await this.requestBatch(batch, config, signal)
      const cacheEntries: Array<{ hash: string; dim: number; vector: Float32Array }> = []
      batch.forEach((text, batchIndex) => {
        const vector = batchVectors[batchIndex]
        for (const index of textToIndexes.get(text) ?? []) vectors[index] = vector
        cacheEntries.push({
          hash: embeddingHash(config.embeddingModel, config.vectorDimensions, text),
          dim: config.vectorDimensions,
          vector
        })
      })
      this.deps.store.putEmbeddingCache(cacheEntries)
      // 批间让出：大文档动辄上百批，不让出会把主进程的定时器/交互一起挡住
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return vectors
  }

  /** 单批请求：重试 → 维度校验 → L2 归一化 */
  private async requestBatch(
    batch: string[],
    config: KnowledgeEngineConfig,
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    const url = embeddingsUrl(config.embeddingBaseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.embeddingApiKey) headers.Authorization = `Bearer ${config.embeddingApiKey}`
    const transport = this.deps.transport ?? defaultTransport

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(signal)
      try {
        // dimensions 是 OpenAI 兼容可选参数；部分网关不认它会 400，降级去掉再试一次
        const body: Record<string, unknown> = {
          model: config.embeddingModel,
          input: batch,
          encoding_format: 'float',
          dimensions: config.vectorDimensions
        }
        let payload: unknown
        try {
          payload = await transport({
            url,
            headers,
            body,
            timeoutMs: EMBED_BATCH_TIMEOUT_MS,
            signal
          })
        } catch (err) {
          if (isHttpStatus(err, 400)) {
            delete body.dimensions
            payload = await transport({
              url,
              headers,
              body,
              timeoutMs: EMBED_BATCH_TIMEOUT_MS,
              signal
            })
          } else {
            throw err
          }
        }
        const vectors = parseEmbeddingsPayload(payload, batch.length, config.vectorDimensions)
        return vectors.map(normalizeVector)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetryable(err) || attempt === MAX_RETRIES) break
        const backoff = 500 * 2 ** attempt
        console.warn(`[knowledge-embedding] 第 ${attempt + 1} 次失败，${backoff}ms 后重试：`, lastError.message)
        await delay(backoff, signal)
      }
    }
    throw new Error(`向量化失败：${lastError?.message ?? '未知原因'}`)
  }
}

/** 默认传输：统一 HTTP 客户端（代理由 main-http 按请求注入） */
const defaultHttp = createMainHttpClient({ purpose: 'knowledge-embedding' })

const defaultTransport: EmbeddingTransport = async ({ url, headers, body, timeoutMs, signal }) => {
  const response = await defaultHttp.post(url, body, {
    headers,
    timeout: timeoutMs,
    signal,
    // 交给业务层判断状态码，避免 axios 把错误信息吞成通用文案
    validateStatus: (status) => status >= 200 && status < 300
  })
  return response.data
}

/** baseUrl → /embeddings 地址（已带 /embeddings 后缀时直接用） */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/embeddings$/i.test(trimmed) ? trimmed : `${trimmed}/embeddings`
}

/** 缓存键：模型 | 维度 | 文本（改模型或维度天然失效） */
export function embeddingHash(model: string, dim: number, text: string): string {
  return createHash('sha1').update(`${model}|${dim}|${text}`).digest('hex')
}

/** 解析 OpenAI 兼容响应：`{ data: [{ embedding, index? }] }` */
export function parseEmbeddingsPayload(
  payload: unknown,
  expected: number,
  dim: number
): Float32Array[] {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('响应缺少 data 数组')
  if (data.length !== expected) {
    throw new Error(`返回条数不符：期望 ${expected}，实际 ${data.length}`)
  }
  const ordered = [...(data as Array<{ embedding?: unknown; index?: number }>)].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0)
  )
  return ordered.map((item, position) => {
    const embedding = item?.embedding
    if (!Array.isArray(embedding) || embedding.length !== dim) {
      throw new Error(
        `向量维度不符（第 ${position + 1} 条）：期望 ${dim}，实际 ${Array.isArray(embedding) ? embedding.length : '非数组'}`
      )
    }
    return Float32Array.from(embedding as number[])
  })
}

/** L2 归一化（零向量原样返回） */
export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (!norm) return vector
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  return out
}

function isRetryable(err: unknown): boolean {
  const status = httpStatusOf(err)
  if (status !== null) return RETRYABLE_STATUS.has(status)
  // 网络层错误（超时/连接重置/取消）中，取消不重试
  const code = (err as { code?: string })?.code
  if (code === 'ERR_CANCELED' || code === 'ERR_CANCELED_BY_USER') return false
  return true
}

function isHttpStatus(err: unknown, status: number): boolean {
  return httpStatusOf(err) === status
}

function httpStatusOf(err: unknown): number | null {
  const response = (err as { response?: { status?: number } })?.response
  const status = response?.status
  return typeof status === 'number' ? status : null
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
