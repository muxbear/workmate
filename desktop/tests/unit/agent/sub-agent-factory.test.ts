import { describe, expect, it } from 'vitest'
import { buildExpertDescription } from '../../../src/main/agent/SubAgentFactory'
import type { DesktopExpert } from '../../../src/shared/contracts'

/** 自 AgentManager 外移的装配规则：描述文案为纯函数，直接单测（此前内联无法脱离 Manager 测） */
function makeExpert(overrides: Partial<DesktopExpert> = {}): DesktopExpert {
  return {
    id: 'e1',
    name: '文档写作专家',
    title: '内容创作',
    tags: ['文档写作'],
    desc: '根据写作要求撰写文章',
    color: '',
    icon: '',
    category: 'content_creation',
    rating: 0,
    users: '0',
    initials: '文',
    systemPrompt: '',
    tools: ['document.assemble'],
    providerId: null,
    modelId: null,
    modelName: null,
    modelType: null,
    skills: [],
    mcpConfigs: [],
    promptTemplate: '',
    expertiseAreas: ['文档写作', '公文'],
    isExpert: true,
    ...overrides
  }
}

describe('buildExpertDescription（专家 → 委派描述）', () => {
  it('包含名称/标题/专长/适用场景/工具', () => {
    const desc = buildExpertDescription(makeExpert())
    expect(desc).toContain('文档写作专家：内容创作。')
    expect(desc).toContain('专长领域：文档写作、公文。')
    expect(desc).toContain('当任务涉及文档写作时应优先委派')
    expect(desc).toContain('可用工具：document.assemble')
  })

  it('缺省回退：专长取 desc、标签取「通用任务」、无工具用文案占位', () => {
    const desc = buildExpertDescription(
      makeExpert({ expertiseAreas: [], tags: [], tools: [], desc: '兜底描述' })
    )
    expect(desc).toContain('专长领域：兜底描述。')
    expect(desc).toContain('当任务涉及通用任务时应优先委派')
    expect(desc).toContain('可用工具：无专用工具')
  })

  it('启用的 MCP 工具名并入工具清单', () => {
    const desc = buildExpertDescription(
      makeExpert({
        mcpConfigs: [
          {
            mcpToolId: 'm1',
            mcpToolName: 'AI 视频生成',
            transport: 'streamable_http',
            url: '',
            sseUrl: '',
            streamableHttpUrl: 'http://127.0.0.1:1/mcp',
            config: {},
            enabled: true
          },
          {
            mcpToolId: 'm2',
            mcpToolName: '未启用工具',
            transport: 'streamable_http',
            url: '',
            sseUrl: '',
            streamableHttpUrl: 'http://127.0.0.1:1/mcp2',
            config: {},
            enabled: false
          }
        ]
      })
    )
    expect(desc).toContain('MCP 工具：AI 视频生成')
    expect(desc).not.toContain('未启用工具')
  })
})
