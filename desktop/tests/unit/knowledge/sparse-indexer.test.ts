import { describe, expect, it } from 'vitest'
import { SparseIndexer, quoteFtsToken } from '../../../src/main/knowledge/SparseIndexer'
import type { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'

// 分词与 MATCH 构造不触达数据库，用空壳 store 即可
const indexer = new SparseIndexer({} as unknown as KnowledgeStore)

describe('SparseIndexer 分词', () => {
  it('中文按词切分，过滤标点与空白', () => {
    const tokens = indexer.tokenize('知识库的向量检索（RAG）！')
    expect(tokens.split(' ')).toContain('知识')
    expect(tokens.split(' ')).toContain('向量')
    expect(tokens.split(' ')).toContain('rag')
    expect(tokens).not.toContain('（')
    expect(tokens).not.toContain('！')
  })

  it('拉丁词统一小写，便于大小写无关命中', () => {
    expect(indexer.tokenize('BM25 Hybrid')).toBe('bm25 hybrid')
  })

  it('同一输入两次分词结果稳定', () => {
    const text = '混合检索与重排（RRF 融合）'
    expect(indexer.tokenize(text)).toBe(indexer.tokenize(text))
  })
})

describe('SparseIndexer MATCH 构造', () => {
  it('token 加引号转义后用 OR 连接', () => {
    expect(indexer.buildMatch('向量 检索')).toBe('"向量" OR "检索"')
  })

  it('FTS 语法字符不会作为语法进入 MATCH（分词是第一道屏障）', () => {
    const match = indexer.buildMatch('向量 AND (检索* OR "注入")')
    // 括号 / 星号 / 引号都被分词剔除；AND 变成普通词项（被引号包裹后无语法意义）
    expect(match).toBe('"向量" OR "and" OR "检索" OR "or" OR "注入"')
  })

  it('quoteFtsToken：token 内含引号时翻倍转义（第二道防线）', () => {
    expect(quoteFtsToken('他说"你好"')).toBe('"他说""你好"""')
  })

  it('纯标点/空白查询返回 null（不落 SQL）', () => {
    expect(indexer.buildMatch('，。！？   ')).toBeNull()
    expect(indexer.buildMatch('')).toBeNull()
  })

  it('token 数量有上限（超长查询不撑爆 MATCH）', () => {
    const tokens = indexer.tokensOf(Array.from({ length: 200 }, (_, i) => `词${i}`).join(' '))
    expect(tokens.length).toBeLessThanOrEqual(32)
  })
})
