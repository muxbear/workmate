import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import KbQaPanel from '@/components/knowledgeBase/KbQaPanel.vue'
import { QA_TAB_KEY, useKbQaStore } from '@/stores/kbQa'
import type { KBDoc } from '@/types/knowledgeBase'

/**
 * 问答区的标签行（需求 3 / 4）。
 *
 * 三条不变式：
 *
 * 1. **「问答」标签不可删除**——它是这个面板的常驻首标签；
 * 2. **文档标签的关闭按钮不抢激活态**（点关闭只是关掉它，不是"切过去再关"）；
 * 3. **标签放不下时才出现左右移动按钮**——放得下却常驻两个箭头会让标签行变窄，
 *    形成"因为显示了箭头所以放不下"的自锁。
 */

function doc(overrides: Partial<KBDoc> = {}): KBDoc {
  return {
    id: 'doc-1',
    name: '报告.md',
    type: 'md',
    folder: null,
    size: '1 KB',
    status: 'indexed',
    progress: 100,
    chunks: 3,
    entities: 0,
    relations: 0,
    uploadedAt: '2026-09-26',
    errorMessage: null,
    graphError: null,
    parseWarning: null,
    stages: [],
    config: null,
    ...overrides,
  }
}

function factory() {
  return mount(KbQaPanel, {
    global: {
      // 只测标签行与面板骨架：问答内容与文档预览各自有自己的用例
      stubs: { KbQaTab: true, KbDocDetailDrawer: true },
    },
  })
}

/**
 * 面板默认是**收起**的（进知识库页只有内容区），所以"要看标签行"的用例都得先展开。
 * 走真实的展开按钮而不是改 store 字段：顺便把展开这条路也跑一遍。
 */
async function expand(wrapper: ReturnType<typeof factory>) {
  await wrapper.find('.panel-icon-btn').trigger('click')
  await nextTick()
}

/** 给标签可视区伪造一个"内容比容器宽"的尺寸（jsdom 里两者恒为 0） */
function makeOverflowing(wrapper: ReturnType<typeof factory>) {
  const viewport = wrapper.find('.tabs-viewport').element
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 600 })
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 200 })
  Object.defineProperty(viewport, 'scrollLeft', { configurable: true, value: 0, writable: true })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('KbQaPanel · 默认态', () => {
  it('默认收起：只有一条轨道与展开按钮，没有标签行', () => {
    const wrapper = factory()
    expect(useKbQaStore().collapsed).toBe(true)
    expect(wrapper.find('.tabs-viewport').exists()).toBe(false)
    expect(wrapper.find('.panel-icon-btn').attributes('aria-label')).toBe('展开问答区')
  })

  it('在文档列表里点开一篇文档会自动展开（不用先手动展开一次）', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    expect(wrapper.find('.tabs-viewport').exists()).toBe(false)

    store.openDocTab('kb-1', doc())
    await nextTick()

    expect(store.collapsed).toBe(false)
    expect(wrapper.find('.tabs-viewport').exists()).toBe(true)
    expect(wrapper.find('.panel-tab.is-active').text()).toContain('报告.md')
  })
})

describe('KbQaPanel · 标签行', () => {
  it('首标签是「问答」，没有关闭按钮', async () => {
    const wrapper = factory()
    await expand(wrapper)
    const tabs = wrapper.findAll('.panel-tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].text()).toContain('问答')
    expect(tabs[0].find('.tab-close').exists()).toBe(false)
    expect(tabs[0].classes()).toContain('is-active')
  })

  it('打开文档后多出一个可关闭的标签，并成为激活项', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc())
    await nextTick()

    const tabs = wrapper.findAll('.panel-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].text()).toContain('报告.md')
    expect(tabs[1].classes()).toContain('is-active')
    expect(tabs[1].find('.tab-close').exists()).toBe(true)
  })

  it('点关闭按钮关掉该标签，并回落到「问答」', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc())
    await nextTick()

    await wrapper.findAll('.panel-tab')[1].find('.tab-close').trigger('click')
    expect(store.docTabs).toHaveLength(0)
    expect(store.activeKey).toBe(QA_TAB_KEY)
    expect(wrapper.findAll('.panel-tab')).toHaveLength(1)
  })

  it('关闭非激活标签不会把激活态带走', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc({ id: 'doc-1', name: '甲.md' }))
    store.openDocTab('kb-1', doc({ id: 'doc-2', name: '乙.md' }))
    store.activateTab('doc:kb-1:doc-1')
    await nextTick()

    await wrapper.findAll('.panel-tab')[2].find('.tab-close').trigger('click')
    expect(store.activeKey).toBe('doc:kb-1:doc-1')
  })

  it('放得下时不出现移动按钮', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc())
    await nextTick()
    await flushPromises()
    expect(wrapper.findAll('.tab-scroll')).toHaveLength(0)
  })

  it('放不下时出现左右移动按钮，标签变多也仍然只有一个左移一个右移', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc())   // 开文档会顺带展开面板
    await nextTick()
    makeOverflowing(wrapper)
    // 尺寸变了要触发一次 syncOverflow：滚一下即可（组件监听 @scroll）
    await wrapper.find('.tabs-viewport').trigger('scroll')

    expect(wrapper.findAll('.tab-scroll')).toHaveLength(2)

    store.openDocTab('kb-1', doc({ id: 'doc-2', name: '乙.md' }))
    await nextTick()
    expect(wrapper.findAll('.tab-scroll')).toHaveLength(2)
  })

  it('已经在最左边时左移按钮禁用', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    store.openDocTab('kb-1', doc())
    await nextTick()
    makeOverflowing(wrapper)
    await wrapper.find('.tabs-viewport').trigger('scroll')

    const [left, right] = wrapper.findAll('.tab-scroll')
    expect(left.attributes('disabled')).toBeDefined()
    expect(right.attributes('disabled')).toBeUndefined()
  })
})

describe('KbQaPanel · 全屏', () => {
  it('标签行右侧有全屏按钮，点一下进入全屏并换成「还原」', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    await expand(wrapper)

    const btn = wrapper.find('.fullscreen-btn')
    expect(btn.attributes('title')).toBe('全屏')

    await btn.trigger('click')
    expect(store.fullscreen).toBe(true)
    expect(wrapper.find('.fullscreen-btn').attributes('title')).toBe('还原')
    expect(wrapper.find('.qa-panel').classes()).toContain('fullscreen')
  })

  it('全屏态不写死像素宽度（宽度交给 flex 撑满）', async () => {
    const store = useKbQaStore()
    store.syncShellWidth(1600)
    store.setPanelWidth(440)
    const wrapper = factory()
    await expand(wrapper)

    expect(wrapper.find('.qa-panel').attributes('style')).toContain('width: 440px')
    await wrapper.find('.fullscreen-btn').trigger('click')
    await nextTick()
    expect(wrapper.find('.qa-panel').attributes('style') ?? '').not.toContain('width')
  })
})

describe('KbQaPanel · 折叠', () => {
  it('收起后只剩展开按钮，且不再有标签行', async () => {
    const store = useKbQaStore()
    const wrapper = factory()
    await expand(wrapper)

    await wrapper.find('.panel-icon-btn').trigger('click')
    expect(store.collapsed).toBe(true)
    expect(wrapper.find('.tabs-viewport').exists()).toBe(false)
    expect(wrapper.find('.panel-icon-btn').attributes('aria-label')).toBe('展开问答区')
  })

  it('收起再展开，宽度还原成收起前的值', async () => {
    const store = useKbQaStore()
    store.syncShellWidth(1600)
    store.setPanelWidth(520)
    const wrapper = factory()

    await expand(wrapper)
    await wrapper.find('.panel-icon-btn').trigger('click')   // 收起
    await wrapper.find('.panel-icon-btn').trigger('click')   // 再展开
    expect(store.collapsed).toBe(false)
    expect(store.panelWidth).toBe(520)
    expect(wrapper.find('.tabs-viewport').exists()).toBe(true)
  })
})
