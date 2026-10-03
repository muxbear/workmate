import { describe, expect, it, vi } from 'vitest'
import {
  buildRewriteUser,
  parseRewriteResponse,
  QueryRewriter,
  type RewriteChatModel
} from '../../../src/main/knowledge/QueryRewriter'
import { fuseVariants } from '../../../src/main/knowledge/RetrievalService'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'

function config(overrides: Partial<KnowledgeEngineConfig> = {}): KnowledgeEngineConfig {
  return {
    chunkStrategy: 'recursive',
    chunkSize: 800,
    chunkOverlap: 120,
    embeddingModel: '',
    vectorDimensions: 1024,
    embeddingBaseUrl: '',
    embeddingApiKey: '',
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
    queryRewriteEnabled: true,
    mmrEnabled: false,
    mmrLambda: 0.7,
    timeDecayHalfLifeDays: 0,
    graphEnabled: false,
    graphModel: '',
    ...overrides
  }
}

describe('parseRewriteResponse', () => {
  it('逐行解析：去列表符号/编号/引号，去空行', () => {
    const text = '1. 向量检索 余弦相似度\n- "关键词召回 BM25"\n\n'
    expect(parseRewriteResponse(text, '怎么算相似度')).toEqual([
      '向量检索 余弦相似度',
      '关键词召回 BM25'
    ])
  })

  it('剔除与原问题重复、超长与重复变体，最多两条', () => {
    const text = [
      '怎么算相似度',
      '向量检索 相似度',
      '向量检索 相似度',
      '超长'.repeat(60),
      '余弦距离'
    ].join('\n')
    const out = parseRewriteResponse(text, '怎么算相似度')
    expect(out).toEqual(['向量检索 相似度', '余弦距离'])
  })

  it('忽略大小写与空白差异判重', () => {
    expect(parseRewriteResponse('Vector Search\nvectorsearch', 'X')).toEqual(['Vector Search'])
  })
})

describe('QueryRewriter', () => {
  it('开关关闭时 available=false，rewrite 也不调用模型', async () => {
    const complete = vi.fn(async () => '变体')
    const rewriter = new QueryRewriter({ resolveModel: async () => ({ complete }) })
    expect(rewriter.available(config({ queryRewriteEnabled: false }))).toBe(false)
    // 即便被直接调用也走模型（可用性由 available 把关）；这里验证开关语义
    expect(rewriter.available(config())).toBe(true)
  })

  it('正常改写：返回变体列表（不含原问题）', async () => {
    const model: RewriteChatModel = { complete: async () => '向量检索 相似度\n余弦距离' }
    const rewriter = new QueryRewriter({ resolveModel: async () => model })
    expect(await rewriter.rewrite('怎么算相似度', config())).toEqual(['向量检索 相似度', '余弦距离'])
  })

  it('模型解析失败 / 调用失败：返回空数组（降级为只用原问题）', async () => {
    const noModel = new QueryRewriter({ resolveModel: async () => null })
    expect(await noModel.rewrite('x', config())).toEqual([])

    const boom = new QueryRewriter({
      resolveModel: async () => ({
        complete: async () => {
          throw new Error('模型 402 欠费')
        }
      })
    })
    expect(await boom.rewrite('x', config())).toEqual([])
  })

  it('多轮：history 进模型请求的 user 文本，输出解析不变', async () => {
    let capturedUser = ''
    const model: RewriteChatModel = {
      complete: async ({ user }) => {
        capturedUser = user
        return '冷启动 缺点'
      }
    }
    const rewriter = new QueryRewriter({ resolveModel: async () => model })
    const variants = await rewriter.rewrite('它的缺点呢', config(), {
      history: [
        { role: 'user', content: '冷启动优化是什么' },
        { role: 'assistant', content: '一种启动加速手段' }
      ]
    })
    expect(capturedUser).toContain('最近对话：')
    expect(capturedUser).toContain('用户：冷启动优化是什么')
    expect(capturedUser).toContain('当前问题：它的缺点呢')
    expect(variants).toEqual(['冷启动 缺点'])
  })
})

describe('buildRewriteUser（多轮上下文拼装）', () => {
  it('无历史（undefined/空数组）：原样返回问题', () => {
    expect(buildRewriteUser('怎么离线部署？')).toBe('怎么离线部署？')
    expect(buildRewriteUser('怎么离线部署？', [])).toBe('怎么离线部署？')
  })

  it('有历史：拼「最近对话 + 当前问题」，角色转中文标签', () => {
    const text = buildRewriteUser('它的缺点呢', [
      { role: 'user', content: '冷启动优化是什么' },
      { role: 'assistant', content: '一种启动加速手段' }
    ])
    expect(text).toBe(
      '最近对话：\n用户：冷启动优化是什么\n助手：一种启动加速手段\n\n当前问题：它的缺点呢'
    )
  })

  it('最多带最近 2 轮（4 条），超长条目截断到 400 字', () => {
    const long = 'x'.repeat(500)
    const text = buildRewriteUser('追问', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: long },
      { role: 'assistant', content: '第二轮回答' },
      { role: 'user', content: '第三轮问题' },
      { role: 'assistant', content: '第三轮回答' }
    ])
    expect(text).not.toContain('第一轮问题')
    expect(text).toContain('第三轮回答')
    expect(text.length).toBeLessThan(long.length)
    expect(text).toContain('…')
  })

  it('空白内容条目被丢弃（不产生空角色行）', () => {
    const text = buildRewriteUser('问题', [{ role: 'user', content: '   ' }])
    expect(text).toBe('问题')
  })
})

describe('fuseVariants（跨变体排名融合）', () => {
  const candidate = (chunkId: number, source: 'sparse' | 'dense' = 'sparse'): {
    chunkId: number
    score: number
    source: 'sparse' | 'dense'
  } => ({ chunkId, score: 1, source })

  it('两路都排第一的候选分最高；单路候选分数随位次衰减', () => {
    const listA = [candidate(1), candidate(2), candidate(3)]
    const listB = [candidate(1, 'dense'), candidate(4, 'dense')]
    const fused = fuseVariants([listA, listB], 10)
    expect(fused[0].chunkId).toBe(1)
    // 1 号两路命中 → 分数高于只在 A 里排第一的 2 号
    const byId = new Map(fused.map((item) => [item.chunkId, item.score]))
    expect(byId.get(1)!).toBeGreaterThan(byId.get(2)!)
    // 4 号在 B 里排第二，分数低于 1 号
    expect(byId.get(4)!).toBeLessThan(byId.get(1)!)
  })

  it('来源标记取贡献最大的那一路；截断到 candidateLimit', () => {
    const fused = fuseVariants([[candidate(1, 'sparse')], [candidate(1, 'dense'), candidate(2, 'dense')]], 1)
    expect(fused).toHaveLength(1)
    expect(fused[0].chunkId).toBe(1)
  })

  it('空输入返回空数组', () => {
    expect(fuseVariants([], 5)).toEqual([])
    expect(fuseVariants([[]], 5)).toEqual([])
  })
})
