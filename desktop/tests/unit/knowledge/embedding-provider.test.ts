import { describe, expect, it, vi } from 'vitest'
import {
  EmbeddingProvider,
  embeddingsUrl,
  parseEmbeddingsPayload,
  type EmbeddingTransport
} from '../../../src/main/knowledge/EmbeddingProvider'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'

/** 内存缓存替身（与 KnowledgeStore 的同名方法同语义） */
function createCacheFake(): {
  getEmbeddingCache: (hashes: string[]) => Map<string, Float32Array>
  putEmbeddingCache: (entries: Array<{ hash: string; dim: number; vector: Float32Array }>) => void
  size: () => number
} {
  const map = new Map<string, Float32Array>()
  return {
    getEmbeddingCache: (hashes) => {
      const out = new Map<string, Float32Array>()
      for (const hash of hashes) {
        const hit = map.get(hash)
        if (hit) out.set(hash, hit)
      }
      return out
    },
    putEmbeddingCache: (entries) => {
      for (const entry of entries) map.set(entry.hash, entry.vector)
    },
    size: () => map.size
  }
}

const DIM = 4

function config(overrides: Partial<KnowledgeEngineConfig> = {}): KnowledgeEngineConfig {
  return {
    chunkStrategy: 'recursive',
    chunkSize: 800,
    chunkOverlap: 120,
    embeddingModel: 'test-embed',
    vectorDimensions: DIM,
    embeddingBaseUrl: 'http://gw.internal/v1',
    embeddingApiKey: 'sk-test',
    sparseRetrieval: true,
    bm25K1: 1.5,
    bm25B: 0.75,
    hybridWeight: 0.65,
    rerankEnabled: false,
    rerankModel: '',
    rerankBaseUrl: '',
    rerankApiKey: '',
    topK: 12,
    minSimilarity: 0.53,
    graphEnabled: false,
    graphModel: '',
    ...overrides
  }
}

/** 确定性伪向量：按文本长度造一个单位向量 */
function vectorFor(text: string, dim = DIM): number[] {
  const out = new Array(dim).fill(0)
  out[text.length % dim] = 3
  out[(text.length + 1) % dim] = 4
  return out
}

/** 把向量包装成 OpenAI 兼容响应（可打乱顺序验证 index 排序） */
function payloadFor(inputs: string[], dim = DIM, shuffle = false): unknown {
  const items = inputs.map((text, index) => ({ embedding: vectorFor(text, dim), index }))
  return { data: shuffle ? items.reverse() : items }
}

/** 记录调用的传输替身 */
function createTransport(
  handler: (input: { body: { input?: string[]; dimensions?: number } }) => unknown
): { transport: EmbeddingTransport; calls: Array<{ body: { input?: string[]; dimensions?: number } }> } {
  // 记录 body 的快照（provider 会原地 delete dimensions，按引用记录会失真）
  const calls: Array<{ body: { input?: string[]; dimensions?: number } }> = []
  const transport: EmbeddingTransport = async (input) => {
    calls.push({ body: { ...(input.body as { input?: string[]; dimensions?: number }) } })
    return handler(input as { body: { input?: string[]; dimensions?: number } })
  }
  return { transport, calls }
}

function httpError(status: number): Error & { response: { status: number } } {
  const error = new Error(`HTTP ${status}`) as Error & { response: { status: number } }
  error.response = { status }
  return error
}

describe('EmbeddingProvider.available', () => {
  it('未配置端点 / 模型为空时不可用', () => {
    const provider = new EmbeddingProvider({ store: createCacheFake() })
    expect(provider.available(config())).toBe(true)
    expect(provider.available(config({ embeddingBaseUrl: '' }))).toBe(false)
    expect(provider.available(config({ embeddingBaseUrl: '   ' }))).toBe(false)
    expect(provider.available(config({ embeddingModel: '' }))).toBe(false)
  })

  it('不可用时 embed 直接拒绝（不静默返回空向量）', async () => {
    const provider = new EmbeddingProvider({ store: createCacheFake() })
    await expect(provider.embed(['x'], config({ embeddingBaseUrl: '' }))).rejects.toThrow(
      '嵌入端点未配置'
    )
  })
})

describe('EmbeddingProvider.embed', () => {
  it('按 32 条/批切分，返回顺序与入参一致，向量已 L2 归一化', async () => {
    const cache = createCacheFake()
    const { transport, calls } = createTransport(({ body }) => payloadFor(body.input ?? []))
    const provider = new EmbeddingProvider({ store: cache, transport })

    const texts = Array.from({ length: 40 }, (_, i) => `text-${i}`)
    const vectors = await provider.embed(texts, config())

    expect(vectors).toHaveLength(40)
    expect(calls.map((call) => call.body.input?.length)).toEqual([32, 8])
    // 归一化：伪向量用的是 3-4-5 → 非零维为 0.6 / 0.8
    expect(Array.from(vectors[0])).toEqual(Array.from(normalize(vectorFor('text-0'))))
    expect(
      Array.from(vectors[0])
        .filter((n) => n !== 0)
        .sort()
        .map((n) => Number(n.toFixed(4)))
    ).toEqual([0.6, 0.8])
    // 顺序：第 33 条来自第二批且与入参第 33 个文本对应
    expect(Array.from(vectors[32])).toEqual(Array.from(normalize(vectorFor('text-32'))))
  })

  it('第二批开始时命中缓存：相同文本不重复请求', async () => {
    const cache = createCacheFake()
    const { transport, calls } = createTransport(({ body }) => payloadFor(body.input ?? []))
    const provider = new EmbeddingProvider({ store: cache, transport })

    await provider.embed(['a', 'b'], config())
    expect(calls).toHaveLength(1)
    expect(cache.size()).toBe(2)

    const again = await provider.embed(['a', 'b'], config())
    expect(calls).toHaveLength(1) // 没有新请求
    expect(again).toHaveLength(2)
    expect(again[0].length).toBe(DIM)
  })

  it('同批内重复文本只请求一次（请求条数 = 去重后条数）', async () => {
    const { transport, calls } = createTransport(({ body }) => payloadFor(body.input ?? []))
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })

    const vectors = await provider.embed(['dup', 'unique', 'dup'], config())
    expect(calls).toHaveLength(1)
    expect(calls[0].body.input).toEqual(['dup', 'unique'])
    expect(Array.from(vectors[0])).toEqual(Array.from(vectors[2]))
  })

  it('维度不符 → 抛错且不写缓存（不落半截向量）', async () => {
    const cache = createCacheFake()
    const { transport } = createTransport(({ body }) => payloadFor(body.input ?? [], 8))
    const provider = new EmbeddingProvider({ store: cache, transport })

    await expect(provider.embed(['x'], config())).rejects.toThrow('向量化失败：向量维度不符')
    expect(cache.size()).toBe(0)
  })

  it('503 抖动重试后成功（指数退避，最多 2 次重试）', async () => {
    let attempt = 0
    const { transport, calls } = createTransport(({ body }) => {
      attempt += 1
      if (attempt <= 2) throw httpError(503)
      return payloadFor(body.input ?? [])
    })
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })
    const vectors = await provider.embed(['retry'], config())
    expect(vectors).toHaveLength(1)
    expect(calls).toHaveLength(3)
  }, 10_000)

  it('401 等不可重试错误：立即失败，不重试', async () => {
    const { transport, calls } = createTransport(() => {
      throw httpError(401)
    })
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })
    await expect(provider.embed(['x'], config())).rejects.toThrow('向量化失败')
    expect(calls).toHaveLength(1)
  })

  it('网关不认 dimensions 参数（400）→ 去掉该参数重试一次', async () => {
    const { transport, calls } = createTransport(({ body }) => {
      if (body.dimensions !== undefined) throw httpError(400)
      return payloadFor(body.input ?? [])
    })
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })
    const vectors = await provider.embed(['legacy-gw'], config())
    expect(vectors).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[0].body.dimensions).toBe(DIM)
    expect(calls[1].body.dimensions).toBeUndefined()
  })

  it('取消信号：提前中止（不发起请求）', async () => {
    const controller = new AbortController()
    controller.abort()
    const { transport, calls } = createTransport(({ body }) => payloadFor(body.input ?? []))
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })
    await expect(provider.embed(['x'], config(), controller.signal)).rejects.toThrow('已取消')
    expect(calls).toHaveLength(0)
  })

  it('响应 index 乱序时按 index 还原顺序', async () => {
    const { transport } = createTransport(({ body }) => payloadFor(body.input ?? [], DIM, true))
    const provider = new EmbeddingProvider({ store: createCacheFake(), transport })
    const vectors = await provider.embed(['short', 'much-longer-text'], config())
    // 第二个文本更长 → 归一化后非零维不同，验证按 index 对齐
    expect(Array.from(vectors[0])).toEqual(Array.from(normalize(vectorFor('short'))))
    expect(Array.from(vectors[1])).toEqual(Array.from(normalize(vectorFor('much-longer-text'))))
  })
})

function normalize(values: number[]): Float32Array {
  let norm = 0
  for (const value of values) norm += value * value
  norm = Math.sqrt(norm) || 1
  return Float32Array.from(values.map((value) => value / norm))
}

describe('embeddingsUrl', () => {
  it('拼接 /embeddings，兼容带/不带斜杠与已带后缀', () => {
    expect(embeddingsUrl('http://gw/v1')).toBe('http://gw/v1/embeddings')
    expect(embeddingsUrl('http://gw/v1/')).toBe('http://gw/v1/embeddings')
    expect(embeddingsUrl('http://gw/v1/embeddings')).toBe('http://gw/v1/embeddings')
    expect(embeddingsUrl('  http://gw/v1  ')).toBe('http://gw/v1/embeddings')
  })
})

describe('parseEmbeddingsPayload', () => {
  it('条数不符 / 缺 data 时给出明确错误', () => {
    expect(() => parseEmbeddingsPayload({ data: [] }, 1, DIM)).toThrow('返回条数不符')
    expect(() => parseEmbeddingsPayload({}, 1, DIM)).toThrow('响应缺少 data 数组')
  })

  it('返回 Float32Array 且维度正确', () => {
    const vectors = parseEmbeddingsPayload({ data: [{ embedding: [1, 2, 3] }] }, 1, 3)
    expect(vectors[0]).toBeInstanceOf(Float32Array)
    expect(Array.from(vectors[0])).toEqual([1, 2, 3])
  })
})

describe('EmbeddingProvider 与检索链路（代理传递）', () => {
  it('把解析出的代理显式传给传输层', async () => {
    const seen: Array<unknown> = []
    const transport: EmbeddingTransport = vi.fn(async ({ proxy, body }) => {
      seen.push(proxy)
      return payloadFor((body as { input: string[] }).input)
    })
    const provider = new EmbeddingProvider({
      store: createCacheFake(),
      transport,
      getProxy: async () => ({ host: '127.0.0.1', port: 7890, protocol: 'http' })
    })
    await provider.embed(['x'], config())
    expect(seen[0]).toEqual({ host: '127.0.0.1', port: 7890, protocol: 'http' })
  })
})
