import { describe, expect, it } from 'vitest'
import { ChunkingService, estimateTokens, splitSentences } from '../../../src/main/knowledge/ChunkingService'

const service = new ChunkingService()

/** 切片必须能用 charStart/charEnd 从原文精确还原（引用定位与「不漏字」的底线） */
function assertRestorable(text: string, chunks: Array<{ content: string; charStart: number; charEnd: number }>): void {
  for (const chunk of chunks) {
    expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content)
  }
}

describe('estimateTokens', () => {
  it('纯中文按字数计', () => {
    expect(estimateTokens('知识库检索')).toBe(5)
  })

  it('纯英文按 4 字符 1 token 计', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('中英混排分段计', () => {
    // 4 个汉字 + 4 个字母 = 4 + 1
    expect(estimateTokens('向量检索abcd')).toBe(5)
  })

  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('splitSentences', () => {
  it('中英标点都能断句且偏移可还原', () => {
    const text = '第一句。第二句！Third one? 收尾没有标点'
    const sentences = splitSentences(text)
    expect(sentences.map((s) => s.text)).toEqual([
      '第一句。',
      '第二句！',
      'Third one?',
      ' 收尾没有标点'
    ])
    for (const sentence of sentences) {
      expect(text.slice(sentence.start, sentence.end)).toBe(sentence.text)
    }
  })
})

describe('ChunkingService', () => {
  it('空文本返回空数组', async () => {
    const result = await service.split('   \n\n  ', { strategy: 'recursive', chunkSize: 100, chunkOverlap: 0 })
    expect(result.chunks).toEqual([])
  })

  it('recursive：长文分块且每块可还原原文', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `第${i + 1}段：这是用于测试递归切片的正文内容。`).join(
      '\n\n'
    )
    const result = await service.split(text, { strategy: 'recursive', chunkSize: 50, chunkOverlap: 10 })
    expect(result.chunks.length).toBeGreaterThan(2)
    assertRestorable(text, result.chunks)
    expect(result.chunks.map((c) => c.index)).toEqual(result.chunks.map((_, i) => i))
  })

  it('fixed：窗口 + 重叠且可还原', async () => {
    const text = '甲乙丙丁戊己庚辛壬癸'.repeat(10)
    const result = await service.split(text, { strategy: 'fixed', chunkSize: 20, chunkOverlap: 5 })
    expect(result.chunks.length).toBeGreaterThan(1)
    assertRestorable(text, result.chunks)
    // 相邻块存在重叠
    const [first, second] = result.chunks
    expect(second.charStart).toBeLessThan(first.charEnd)
  })

  it('markdown：按标题分段并带标题路径', async () => {
    const text = ['# 一级标题', '正文 A。', '## 二级标题', '正文 B。'].join('\n')
    const result = await service.split(text, { strategy: 'markdown', chunkSize: 100, chunkOverlap: 0 })
    expect(result.chunks.length).toBe(2)
    expect(result.chunks[0].heading).toBe('一级标题')
    expect(result.chunks[1].heading).toBe('一级标题 / 二级标题')
    assertRestorable(text, result.chunks)
  })

  it('overlap >= chunkSize 时钳制并给出告警', async () => {
    const result = await service.split('内容'.repeat(200), {
      strategy: 'recursive',
      chunkSize: 50,
      chunkOverlap: 80
    })
    expect(result.warning).toContain('已钳制')
  })

  it('semantic 无嵌入函数时降级 recursive 并告警', async () => {
    const result = await service.split('句子一。句子二。句子三。'.repeat(20), {
      strategy: 'semantic',
      chunkSize: 30,
      chunkOverlap: 5
    })
    expect(result.warning).toContain('降级')
    expect(result.chunks.length).toBeGreaterThan(0)
  })

  it('semantic 有嵌入函数时按相似度断点，块可还原', async () => {
    // 造两个语义簇：embed 函数按关键词给正交向量
    const text = '苹果香蕉。苹果橘子。苹果葡萄。引擎活塞。引擎气缸。引擎涡轮。'
    const embed = async (sentences: string[]): Promise<Float32Array[]> =>
      sentences.map((sentence) =>
        sentence.includes('引擎') ? new Float32Array([0, 1]) : new Float32Array([1, 0])
      )
    const result = await service.split(text, {
      strategy: 'semantic',
      chunkSize: 100,
      chunkOverlap: 0,
      embedSentences: embed
    })
    expect(result.chunks.length).toBe(2)
    expect(result.chunks[0].content).toContain('苹果')
    expect(result.chunks[1].content).toContain('引擎')
    assertRestorable(text, result.chunks)
  })

  it('超长单句也能切分（硬切兜底）', async () => {
    const text = '啊'.repeat(500)
    const result = await service.split(text, { strategy: 'recursive', chunkSize: 50, chunkOverlap: 0 })
    expect(result.chunks.length).toBeGreaterThan(1)
    assertRestorable(text, result.chunks)
  })

  it('CRLF 归一后偏移与内容一致', async () => {
    const text = '第一行\r\n第二行\r\n第三行'
    const result = await service.split(text, { strategy: 'recursive', chunkSize: 100, chunkOverlap: 0 })
    expect(result.chunks[0].content).not.toContain('\r')
    assertRestorable(`第一行\n第二行\n第三行`, result.chunks)
  })
})
