import { describe, expect, it } from 'vitest'
import {
  RerankProvider,
  parseRerankPayload,
  rerankUrl,
  type RerankTransport
} from '../../../src/main/knowledge/RerankProvider'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'

function config(overrides: Partial<KnowledgeEngineConfig> = {}): KnowledgeEngineConfig {
  return {
    chunkStrategy: 'recursive',
    chunkSize: 800,
    chunkOverlap: 120,
    embeddingModel: 'text-embedding-3-large',
    vectorDimensions: 1024,
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    sparseRetrieval: true,
    bm25K1: 1.5,
    bm25B: 0.75,
    hybridWeight: 0.65,
    rerankEnabled: true,
    rerankModel: 'bge-reranker-v2-m3',
    rerankBaseUrl: 'http://gw.internal/v1',
    rerankApiKey: 'sk-rerank',
    topK: 12,
    minSimilarity: 0.53,
    graphEnabled: false,
    graphModel: '',
    ...overrides
  }
}

function httpError(status: number): Error & { response: { status: number } } {
  const error = new Error(`HTTP ${status}`) as Error & { response: { status: number } }
  error.response = { status }
  return error
}

describe('RerankProvider.available', () => {
  it('端点或模型缺失即不可用', () => {
    const provider = new RerankProvider()
    expect(provider.available(config())).toBe(true)
    expect(provider.available(config({ rerankBaseUrl: '' }))).toBe(false)
    expect(provider.available(config({ rerankModel: '  ' }))).toBe(false)
  })

  it('不可用时不发请求，直接返回 null（调用方保留融合顺序）', async () => {
    let called = 0
    const provider = new RerankProvider({
      transport: async () => {
        called += 1
        return { results: [] }
      }
    })
    const result = await provider.rerank('q', ['a'], config({ rerankBaseUrl: '' }))
    expect(result).toBeNull()
    expect(called).toBe(0)
  })

  it('文档为空返回 null', async () => {
    const provider = new RerankProvider()
    expect(await provider.rerank('q', [], config())).toBeNull()
  })
})

describe('RerankProvider.rerank', () => {
  it('按 index 映射回候选顺序，返回与 documents 等长的分数', async () => {
    const seen: Array<{ body: { model?: string; query?: string; documents?: string[]; top_n?: number } }> = []
    const transport: RerankTransport = async ({ body }) => {
      seen.push({ body: { ...(body as { documents?: string[] }) } })
      return {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 }
        ]
      }
    }
    const provider = new RerankProvider({ transport })
    const scores = await provider.rerank('涡轮', ['a', 'b', 'c'], config())
    expect(scores).toEqual([0.5, 0.1, 0.9])
    expect(seen[0].body.model).toBe('bge-reranker-v2-m3')
    expect(seen[0].body.query).toBe('涡轮')
    expect(seen[0].body.top_n).toBe(3)
  })

  it('兼容 output.results 与 data 两种形态（含 score 字段名）', async () => {
    const provider = new RerankProvider({
      transport: async () => ({ output: { results: [{ index: 0, score: 0.42 }] } })
    })
    expect(await provider.rerank('q', ['a'], config())).toEqual([0.42])

    const provider2 = new RerankProvider({
      transport: async () => ({ data: [{ index: 0, relevance_score: 0.7 }] })
    })
    expect(await provider2.rerank('q', ['a'], config())).toEqual([0.7])
  })

  it('未出现在结果里的候选得 0 分（沉底），不抛错', async () => {
    const provider = new RerankProvider({
      transport: async () => ({ results: [{ index: 1, relevance_score: 0.8 }] })
    })
    expect(await provider.rerank('q', ['a', 'b'], config())).toEqual([0, 0.8])
  })

  it('5xx 重试一次后成功', async () => {
    let attempt = 0
    const provider = new RerankProvider({
      transport: async () => {
        attempt += 1
        if (attempt === 1) throw httpError(503)
        return { results: [{ index: 0, relevance_score: 0.6 }] }
      }
    })
    expect(await provider.rerank('q', ['a'], config())).toEqual([0.6])
    expect(attempt).toBe(2)
  })

  it('401 不可重试：立即降级为 null', async () => {
    let attempt = 0
    const provider = new RerankProvider({
      transport: async () => {
        attempt += 1
        throw httpError(401)
      }
    })
    expect(await provider.rerank('q', ['a'], config())).toBeNull()
    expect(attempt).toBe(1)
  })

  it('响应缺 results：降级为 null 而不是抛错', async () => {
    const provider = new RerankProvider({ transport: async () => ({ ok: true }) })
    expect(await provider.rerank('q', ['a'], config())).toBeNull()
  })

  it('候选超过上限时截断到 50 条', async () => {
    let received = 0
    const provider = new RerankProvider({
      transport: async ({ body }) => {
        received = (body as { documents: string[] }).documents.length
        return { results: [] }
      }
    })
    await provider.rerank('q', new Array(80).fill('x'), config())
    expect(received).toBe(50)
  })

  it('代理显式传给传输层', async () => {
    let seenProxy: unknown
    const provider = new RerankProvider({
      transport: async ({ proxy }) => {
        seenProxy = proxy
        return { results: [] }
      },
      getProxy: async () => ({ host: '10.0.0.1', port: 8080, protocol: 'http' })
    })
    await provider.rerank('q', ['a'], config())
    expect(seenProxy).toEqual({ host: '10.0.0.1', port: 8080, protocol: 'http' })
  })
})

describe('rerankUrl / parseRerankPayload', () => {
  it('拼接 /rerank，兼容斜杠与已带后缀', () => {
    expect(rerankUrl('http://gw/v1')).toBe('http://gw/v1/rerank')
    expect(rerankUrl('http://gw/v1/')).toBe('http://gw/v1/rerank')
    expect(rerankUrl('http://gw/v1/rerank')).toBe('http://gw/v1/rerank')
  })

  it('非法 index 被忽略，缺 results 抛错（由调用方降级）', () => {
    expect(parseRerankPayload({ results: [{ index: 9, score: 1 }] }, 2)).toEqual([0, 0])
    expect(() => parseRerankPayload({}, 2)).toThrow('响应缺少 results 数组')
  })
})
