import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbDocDetailDrawer from '@/components/knowledgeBase/KbDocDetailDrawer.vue'
import type { DocChunk, KBDoc } from '@/types/knowledgeBase'

const { fetchDocumentChunks } = vi.hoisted(() => ({ fetchDocumentChunks: vi.fn() }))

vi.mock('@/services/knowledgeBaseApi', () => ({ fetchDocumentChunks }))

function doc(): KBDoc {
  return {
    id: 'doc-1',
    name: '手册.md',
    type: 'md',
    size: '1 KB',
    status: 'indexed',
    progress: 100,
    chunks: 1,
    entities: 0,
    relations: 0,
    uploadedAt: '2026-09-24',
    errorMessage: null,
    stages: [],
    config: null,
  }
}

function chunk(content: string): DocChunk {
  return {
    id: 'c1',
    index: 0,
    content,
    tokenCount: 10,
    charCount: content.length,
    pageRef: '',
    section: '第一节',
    entities: [],
  }
}

async function mountWith(content: string) {
  fetchDocumentChunks.mockResolvedValue([chunk(content)])
  const wrapper = mount(KbDocDetailDrawer, {
    props: { doc: doc(), kbId: 'kb-1' },
  })
  await flushPromises()
  return wrapper
}

describe('KbDocDetailDrawer · 切片正文渲染', () => {
  beforeEach(() => {
    fetchDocumentChunks.mockReset()
  })

  it('转义 HTML 标签，不执行切片内的脚本', async () => {
    const wrapper = await mountWith('正常内容 <img src=x onerror="alert(1)"> 结尾')

    const html = wrapper.html()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('转义 script 标签', async () => {
    const wrapper = await mountWith('<script>window.__hacked = true</script>')

    expect(wrapper.html()).not.toContain('<script>window.__hacked')
    expect(wrapper.html()).toContain('&lt;script&gt;')
  })

  it('普通正文与换行不受影响', async () => {
    const wrapper = await mountWith('第一行\n第二行')

    expect(wrapper.html()).toContain('第一行')
    expect(wrapper.html()).toContain('第二行')
  })

  it('搜索时高亮命中词但仍转义标签', async () => {
    const wrapper = await mountWith('标题 <b>加粗</b> 标题')
    const input = wrapper.find('input')
    await input.setValue('标题')
    await flushPromises()

    const html = wrapper.html()
    expect(html).toContain('search-highlight')
    expect(html).not.toContain('<b>加粗</b>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('查询词含 HTML 特殊字符时不误伤正文', async () => {
    const wrapper = await mountWith('a < b 且 a < c')
    const input = wrapper.find('input')
    await input.setValue('a < b')
    await flushPromises()

    expect(wrapper.html()).toContain('search-highlight')
    expect(wrapper.html()).not.toContain('<b ')
  })
})
