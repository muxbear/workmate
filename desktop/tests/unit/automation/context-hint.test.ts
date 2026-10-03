import { describe, expect, it } from 'vitest'
import { buildContextHint } from '../../../src/main/automation/context-hint'

/**
 * 自动化任务「上下文模式」提示词（与 web runner 口径一致）。
 * 重点：知识库模式必须把「有哪些库可用」或「没有可用库」讲清楚，避免后台任务编造资料。
 */
describe('buildContextHint', () => {
  const bases = [
    { id: 'kb-1', name: '产品资料库', docsCount: 12 },
    { id: 'kb-2', name: '研发规范', docsCount: 5 }
  ]

  it('默认模式不追加任何提示', () => {
    expect(buildContextHint({ contextMode: 'default', knowledgeBases: bases })).toBe('')
  })

  it('本地文件模式只声明模式', () => {
    const hint = buildContextHint({ contextMode: 'local', knowledgeBases: bases })
    expect(hint).toContain('【模式】当前任务模式：本地文件。')
    expect(hint).not.toContain('【知识库】')
  })

  it('知识库模式列出可检索的库，并给出工具用法与「空结果不要编造」的约束', () => {
    const hint = buildContextHint({ contextMode: 'knowledge', knowledgeBases: bases })
    expect(hint).toContain('【模式】当前任务模式：知识库。')
    expect(hint).toContain('产品资料库（12 篇）')
    expect(hint).toContain('研发规范（5 篇）')
    expect(hint).toContain('list_knowledge_bases')
    expect(hint).toContain('kb_search')
    expect(hint).toContain('不要编造')
  })

  it('知识库模式但没有可用库：明确说明，不让模型凭常识编造', () => {
    const hint = buildContextHint({ contextMode: 'knowledge', knowledgeBases: [] })
    expect(hint).toContain('没有可检索的本地知识库')
    expect(hint).toContain('不要凭常识编造')
    expect(hint).not.toContain('kb_search')
  })
})
