import { beforeEach, describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia } from 'pinia'
import ExpertPage from '../../../src/renderer/src/views/ExpertPage.vue'
import { experts, type Expert } from '../../../src/renderer/src/store/catalog'

/**
 * 专家卡片渲染验证（SSR，无需 jsdom）
 *
 * 重点验证本次改动新增的两处卡片内容：版本徽标与删除按钮；
 * 删除交互本身（确认弹窗、IPC）由 expertSync store 与 IPC 用例覆盖。
 */

function makeExpert(overrides: Partial<Expert> = {}): Expert {
  return {
    id: 'e1',
    name: '文档写作专家',
    title: '内容创作',
    tags: ['文档写作'],
    desc: '根据写作要求撰写文章',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: 'Zap',
    category: '全部',
    rating: 4.9,
    users: '2.3k',
    initials: '文',
    systemPrompt: '',
    tools: [],
    providerId: null,
    modelId: null,
    promptTemplate: '',
    expertiseAreas: [],
    isExpert: true,
    ...overrides
  }
}

async function render(): Promise<string> {
  const app = createSSRApp(ExpertPage)
  app.use(createPinia())
  return renderToString(app)
}

beforeEach(() => {
  experts.value = []
})

describe('ExpertPage 专家卡片', () => {
  it('EP-01: 有版本号时渲染版本徽标与删除按钮', async () => {
    experts.value = [makeExpert({ version: '1.0.1' })]

    const html = await render()

    expect(html).toContain('v1.0.1')
    expect(html).toContain('expert-version')
    expect(html).toContain('expert-delete-btn')
    expect(html).toContain('删除专家（仅本机）')
  })

  it('EP-02: 无版本号（老数据）时不渲染版本徽标，卡片其余内容照常', async () => {
    experts.value = [makeExpert()]

    const html = await render()

    expect(html).not.toContain('expert-version')
    expect(html).toContain('文档写作专家')
    expect(html).toContain('expert-delete-btn')
  })

  it('EP-03: 未确认删除时不渲染确认弹窗', async () => {
    experts.value = [makeExpert({ version: '1.0.0' })]

    const html = await render()

    expect(html).not.toContain('confirm-card')
    expect(html).not.toContain('expert-toast')
  })

  it('EP-04: 多个专家各自渲染版本徽标', async () => {
    experts.value = [
      makeExpert({ id: 'e1', name: '文档写作专家', version: '1.0.1' }),
      makeExpert({ id: 'e2', name: '视频创作专家', version: '2.3.0' })
    ]

    const html = await render()

    expect(html).toContain('v1.0.1')
    expect(html).toContain('v2.3.0')
    // 两张卡片各一个删除按钮
    expect(html.match(/expert-delete-btn/g)).toHaveLength(2)
  })
})
