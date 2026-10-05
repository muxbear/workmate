import { describe, expect, it } from 'vitest'
import {
  INDEX_SNAPSHOT_KEYS,
  indexSignature,
  toEngineConfig,
  type KnowledgeEngineConfig
} from '../../../src/main/knowledge/knowledge-config'

/**
 * 索引口径指纹红线测试（动线数据保护）。
 *
 * indexSignature 决定「重建索引时是否跳过该文档」：指纹的计算方式或参与项一旦变化，
 * 所有存量文档都会被判定为「配置已变」→ 触发全量重建（embedding 全量重跑）。
 * 本文件把「指纹的精确输出 / 参与项集合 / 非参与项不敏感 / 快照键清单」钉死，
 * 作为知识库配置 registry 化重构（P2 剩余项）的前置回归网。
 */

/** 全默认配置（toEngineConfig 空输入 → 内部 FALLBACK） */
const base: KnowledgeEngineConfig = toEngineConfig({}, {})

describe('indexSignature（红线：指纹不变）', () => {
  it('全默认配置的指纹逐字节钉死（改哈希算法/分隔符/参与项顺序立即报警）', () => {
    expect(indexSignature(base, true)).toBe('04781a6b7136be515a104e9b1efa042a0fcd24b6')
    expect(indexSignature(base, false)).toBe('6cfda8abf8842b5c86fa3727067141a467c784b7')
  })

  it('embeddingUsed 翻转 → 指纹必变（向量可用性属于索引口径）', () => {
    expect(indexSignature(base, true)).not.toBe(indexSignature(base, false))
  })

  it('7 个参与项逐一变更 → 指纹必变', () => {
    const mutations: Array<Partial<KnowledgeEngineConfig>> = [
      { chunkStrategy: 'fixed' },
      { chunkSize: 801 },
      { chunkOverlap: 121 },
      { embeddingModel: 'text-embedding-3-small' },
      { vectorDimensions: 1536 },
      { graphEnabled: true },
      { graphModel: 'GLM-5' }
    ]
    for (const patch of mutations) {
      const next = { ...base, ...patch }
      expect(indexSignature(next, true), JSON.stringify(patch)).not.toBe(indexSignature(base, true))
    }
  })

  it('检索侧参数不参与指纹（改这些不应触发重建）', () => {
    const retrievals: Array<Partial<KnowledgeEngineConfig>> = [
      { sparseRetrieval: false },
      { bm25K1: 1.8 },
      { bm25B: 0.6 },
      { hybridWeight: 0.5 },
      { rerankEnabled: true },
      { rerankModel: 'bge-reranker-v2-m3' },
      { topK: 30 },
      { minSimilarity: 0.8 },
      { queryRewriteEnabled: true },
      { mmrEnabled: true },
      { mmrLambda: 0.3 },
      { timeDecayHalfLifeDays: 30 },
      { embeddingBaseUrl: 'https://e.example' },
      { embeddingApiKey: 'k1' },
      { rerankBaseUrl: 'https://r.example' },
      { rerankApiKey: 'k2' }
    ]
    for (const patch of retrievals) {
      const next = { ...base, ...patch }
      expect(indexSignature(next, true), JSON.stringify(patch)).toBe(indexSignature(base, true))
    }
  })

  it('上传快照键清单钉死（14 项；registry 化派生后必须逐项一致）', () => {
    expect([...INDEX_SNAPSHOT_KEYS]).toEqual([
      'chunkStrategy',
      'chunkSize',
      'chunkOverlap',
      'embeddingModel',
      'vectorDimensions',
      'sparseRetrieval',
      'bm25K1',
      'bm25B',
      'hybridWeight',
      'rerankEnabled',
      'rerankModel',
      'topK',
      'graphEnabled',
      'graphModel'
    ])
  })
})

describe('toEngineConfig（registry 化重构的输出锚点）', () => {
  it('全量覆盖 + 全局端点：22 字段逐项相等', () => {
    const effective = {
      chunkStrategy: 'markdown',
      chunkSize: 1024,
      chunkOverlap: 200,
      embeddingModel: 'text-embedding-3-small',
      vectorDimensions: 1536,
      sparseRetrieval: false,
      bm25K1: 1.2,
      bm25B: 0.5,
      hybridWeight: 0.4,
      rerankEnabled: true,
      rerankModel: 'bge-reranker-v2-m3',
      topK: 20,
      minSimilarity: 0.66,
      queryRewriteEnabled: true,
      mmrEnabled: true,
      mmrLambda: 0.3,
      timeDecayHalfLifeDays: 7,
      graphEnabled: true,
      graphModel: 'GLM-5'
    }
    const global = {
      'knowledge.embeddingBaseUrl': ' https://e.example ',
      'knowledge.embeddingApiKey': 'ek',
      'knowledge.rerankBaseUrl': 'https://r.example',
      'knowledge.rerankApiKey': 'rk'
    }
    expect(toEngineConfig(effective, global)).toEqual({
      chunkStrategy: 'markdown',
      chunkSize: 1024,
      chunkOverlap: 200,
      embeddingModel: 'text-embedding-3-small',
      vectorDimensions: 1536,
      embeddingBaseUrl: 'https://e.example', // 端点做了 trim
      embeddingApiKey: 'ek',
      sparseRetrieval: false,
      bm25K1: 1.2,
      bm25B: 0.5,
      hybridWeight: 0.4,
      rerankEnabled: true,
      rerankModel: 'bge-reranker-v2-m3',
      rerankBaseUrl: 'https://r.example',
      rerankApiKey: 'rk',
      topK: 20,
      minSimilarity: 0.66,
      queryRewriteEnabled: true,
      mmrEnabled: true,
      mmrLambda: 0.3,
      timeDecayHalfLifeDays: 7,
      graphEnabled: true,
      graphModel: 'GLM-5'
    })
  })

  it('越界/未知值回退：未知切片策略 → recursive；minSimilarity 越界 → 钳到 [0,1]', () => {
    const config = toEngineConfig(
      { chunkStrategy: 'weird', minSimilarity: 2 },
      {}
    )
    expect(config.chunkStrategy).toBe('recursive')
    expect(config.minSimilarity).toBe(1)
  })
})
