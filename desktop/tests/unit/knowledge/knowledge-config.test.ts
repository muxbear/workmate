import { describe, expect, it } from 'vitest'
import {
  INDEX_SNAPSHOT_KEYS,
  indexSignature,
  normalizeIndexSnapshot,
  overlaySnapshot,
  pickIndexSnapshot,
  toEngineConfig
} from '../../../src/main/knowledge/knowledge-config'

const EFFECTIVE = {
  chunkStrategy: 'markdown',
  chunkSize: 500,
  chunkOverlap: 60,
  embeddingModel: 'bge-m3',
  vectorDimensions: 1024,
  sparseRetrieval: true,
  bm25K1: 1.2,
  bm25B: 0.6,
  hybridWeight: 0.7,
  rerankEnabled: false,
  rerankModel: 'bge-reranker-v2-m3',
  topK: 8,
  graphEnabled: true,
  graphModel: 'GLM-5',
  minSimilarity: 0.5
}

const GLOBAL = {
  'knowledge.embeddingBaseUrl': 'http://gw.internal/v1 ',
  'knowledge.embeddingApiKey': 'sk-embed',
  'knowledge.rerankBaseUrl': 'http://gw.internal',
  'knowledge.rerankApiKey': 'sk-rerank'
}

describe('toEngineConfig', () => {
  it('生效值 + 全局端点合成强类型配置', () => {
    const config = toEngineConfig(EFFECTIVE, GLOBAL)
    expect(config.chunkStrategy).toBe('markdown')
    expect(config.chunkSize).toBe(500)
    expect(config.embeddingBaseUrl).toBe('http://gw.internal/v1')
    expect(config.embeddingApiKey).toBe('sk-embed')
    expect(config.rerankBaseUrl).toBe('http://gw.internal')
    expect(config.minSimilarity).toBe(0.5)
  })

  it('缺失/非法值回退默认，不抛错', () => {
    const config = toEngineConfig({ chunkStrategy: 'unknown', chunkSize: -1, topK: 0 }, {})
    expect(config.chunkStrategy).toBe('recursive')
    expect(config.chunkSize).toBe(800)
    expect(config.topK).toBe(12)
    expect(config.embeddingBaseUrl).toBe('')
  })
})

describe('上传快照', () => {
  it('快照只含 14 个索引项，不含上传项与端点', () => {
    const snapshot = JSON.parse(pickIndexSnapshot(toEngineConfig(EFFECTIVE, GLOBAL))) as Record<
      string,
      unknown
    >
    expect(Object.keys(snapshot).sort()).toEqual([...INDEX_SNAPSHOT_KEYS].sort())
    expect(snapshot).not.toHaveProperty('maxUploadSize')
    expect(snapshot).not.toHaveProperty('embeddingBaseUrl')
    expect(snapshot).not.toHaveProperty('minSimilarity')
  })

  it('normalizeIndexSnapshot：白名单 + 值校验，非法值抛错', () => {
    expect(normalizeIndexSnapshot({ chunkSize: 400, chunkStrategy: 'fixed' })).toBe(
      JSON.stringify({ chunkStrategy: 'fixed', chunkSize: 400 })
    )
    expect(normalizeIndexSnapshot({})).toBeNull()
    expect(normalizeIndexSnapshot(null)).toBeNull()
    // 白名单外的键被忽略（如试图从渲染层注入端点）
    expect(normalizeIndexSnapshot({ embeddingBaseUrl: 'http://evil' })).toBeNull()
    expect(() => normalizeIndexSnapshot({ chunkSize: 1 })).toThrow('非法')
    expect(() => normalizeIndexSnapshot({ topK: 999 })).toThrow('非法')
  })

  it('overlaySnapshot：只覆盖快照里存在的合法项', () => {
    const base = toEngineConfig(EFFECTIVE, GLOBAL)
    const merged = overlaySnapshot(base, JSON.stringify({ chunkSize: 1234, topK: 'bad' }))
    expect(merged.chunkSize).toBe(1234)
    expect(merged.topK).toBe(base.topK)
    expect(merged.chunkStrategy).toBe('markdown')
  })
})

describe('indexSignature', () => {
  it('索引项变化会改指纹；检索项（topK/rerank）不影响', () => {
    const base = toEngineConfig(EFFECTIVE, GLOBAL)
    const baseSig = indexSignature(base, true)
    expect(indexSignature({ ...base, chunkSize: 501 }, true)).not.toBe(baseSig)
    expect(indexSignature({ ...base, topK: 99 }, true)).toBe(baseSig)
    expect(indexSignature({ ...base, rerankEnabled: true }, true)).toBe(baseSig)
    // 建索引时向量是否可用也要进指纹（否则「先纯稀疏后配端点」不会触发重建）
    expect(indexSignature(base, false)).not.toBe(baseSig)
  })
})
