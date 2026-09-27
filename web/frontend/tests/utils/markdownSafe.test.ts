import { describe, expect, it } from 'vitest'
import { renderSafeMarkdown } from '@/utils/markdownSafe'

/**
 * 问答回答的渲染。
 *
 * 回答里可能夹带**检索到的文档正文**——那是用户上传的任意内容。所以这里既要求
 * 格式化能力（markdown 生效），也要求"HTML 只能以字面量出现"：漏了后者就是一条
 * 存储型 XSS（本模块的 KbDocDetailDrawer 已经因为同样的问题修过一次）。
 */
describe('renderSafeMarkdown', () => {
  it('markdown 格式化能力保留', () => {
    const html = renderSafeMarkdown('**加粗**\n\n- 一\n- 二')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<li>一</li>')
  })

  it('换行按 <br> 处理（模型输出的单换行不该被吞掉）', () => {
    expect(renderSafeMarkdown('第一行\n第二行')).toContain('<br>')
  })

  it('HTML 标签被转义成字面量', () => {
    const html = renderSafeMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('script 标签同样逃不掉', () => {
    const html = renderSafeMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('正文里已有的 HTML 实体不会被二次解码成标签', () => {
    const html = renderSafeMarkdown('&lt;b&gt;不算加粗&lt;/b&gt;')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&amp;lt;')
  })
})
