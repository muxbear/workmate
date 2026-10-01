import { describe, expect, it, vi } from 'vitest'
import { SystemMessage } from '@langchain/core/messages'
import {
  buildExpertDirective,
  createExpertDirectiveMiddleware
} from '../../../src/main/agent/ExpertDirectiveMiddleware'
import type { DesktopExpert } from '../../../src/preload/index.d'

/** 专家夹具（默认给检索专家一段带占位符的委派细则） */
function makeExpert(overrides: Partial<DesktopExpert> = {}): DesktopExpert {
  return {
    id: 'e1',
    name: '互联网信息检索专家',
    title: '互联网信息检索专家',
    tags: [],
    desc: '',
    color: '',
    icon: '',
    category: '',
    rating: 0,
    users: '',
    initials: '',
    systemPrompt: '',
    tools: [],
    providerId: null,
    modelId: null,
    modelName: null,
    modelType: null,
    skills: [],
    mcpConfigs: [],
    promptTemplate: '',
    expertiseAreas: [],
    isExpert: true,
    ...overrides
  }
}

type WrapModelCall = (
  request: Record<string, unknown>,
  handler: (request: Record<string, unknown>) => Promise<unknown>
) => Promise<unknown>

/** 提取 wrapModelCall 钩子（AgentMiddleware 上可选，测试直调） */
function getWrap(mw: ReturnType<typeof createExpertDirectiveMiddleware>): WrapModelCall {
  return mw.wrapModelCall as unknown as WrapModelCall
}

function makeRequest(systemMessage?: SystemMessage): Record<string, unknown> {
  return { model: 'm', ...(systemMessage ? { systemMessage } : {}) }
}

/** 取 handler 首次调用时传入的 systemMessage 文本 */
function mergedText(handler: ReturnType<typeof vi.fn>): string {
  const req = handler.mock.calls[0][0] as { systemMessage?: SystemMessage }
  const content = req.systemMessage?.content
  return typeof content === 'string' ? content : ''
}

describe('ExpertDirectiveMiddleware（选中专家的强制委派指令）', () => {
  it('ED-01: 未选专家时原参转发（不注入任何内容）', async () => {
    const wrap = getWrap(createExpertDirectiveMiddleware(() => []))
    const request = makeRequest()
    const handler = vi.fn().mockResolvedValue('ok')
    const result = await wrap(request, handler)
    expect(handler).toHaveBeenCalledWith(request)
    expect(result).toBe('ok')
  })

  it('ED-02: 选中专家 → 系统提示词末尾追加固定委派指令（含专家名与三步要求）', async () => {
    const wrap = getWrap(createExpertDirectiveMiddleware(() => [makeExpert()]))
    const request = makeRequest(new SystemMessage('基础系统提示词'))
    const handler = vi.fn().mockResolvedValue('ok')
    await wrap(request, handler)

    const text = mergedText(handler)
    expect(text.startsWith('基础系统提示词')).toBe(true)
    expect(text).toContain('## 本次任务的强制委派要求')
    expect(text).toContain('已选择专家「互联网信息检索专家」')
    expect(text).toContain('subagent_type 使用「互联网信息检索专家」')
    expect(text).toContain('基于专家的产出给用户最终回复')
  })

  it('ED-03: 专家 promptTemplate 作为委派细则随行注入，并替换 {name}/{title} 占位符', async () => {
    const expert = makeExpert({
      promptTemplate: '请调用【{name}·{title}】处理，必须原样保留来源链接（{name} 负责核对）。'
    })
    const wrap = getWrap(createExpertDirectiveMiddleware(() => [expert]))
    const handler = vi.fn().mockResolvedValue('ok')
    await wrap(makeRequest(), handler)

    const text = mergedText(handler)
    expect(text).toContain('委派细则（来自专家配置，必须遵守）')
    expect(text).toContain('请调用【互联网信息检索专家·互联网信息检索专家】处理')
    // 所有占位符都被替换（不残留字面量）
    expect(text).not.toContain('{name}')
    expect(text).not.toContain('{title}')
  })

  it('ED-04: 无 systemMessage 时以指令本身作为系统消息', async () => {
    const wrap = getWrap(createExpertDirectiveMiddleware(() => [makeExpert()]))
    const handler = vi.fn().mockResolvedValue('ok')
    await wrap(makeRequest(), handler)
    expect(mergedText(handler).startsWith('## 本次任务的强制委派要求')).toBe(true)
  })

  it('ED-05: systemMessage 为 blocks 数组时先取文本再追加', async () => {
    const message = new SystemMessage([
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' }
    ])
    const wrap = getWrap(createExpertDirectiveMiddleware(() => [makeExpert()]))
    const handler = vi.fn().mockResolvedValue('ok')
    await wrap(makeRequest(message), handler)
    const text = mergedText(handler)
    expect(text.startsWith('第一段第二段')).toBe(true)
    expect(text).toContain('强制委派要求')
  })

  it('ED-06: 多专家（防御）各出一段；空名专家跳过', () => {
    const directive = buildExpertDirective([
      makeExpert({ name: '专家A' }),
      makeExpert({ name: '   ' }),
      makeExpert({ name: '专家B' })
    ])
    expect(directive.match(/## 本次任务的强制委派要求/g)).toHaveLength(2)
    expect(directive).toContain('「专家A」')
    expect(directive).toContain('「专家B」')
  })

  it('ED-07: 中间件名为 expertDirectiveMiddleware', () => {
    const mw = createExpertDirectiveMiddleware(() => [])
    expect(mw.name).toBe('expertDirectiveMiddleware')
    expect(typeof mw.wrapModelCall).toBe('function')
  })
})
