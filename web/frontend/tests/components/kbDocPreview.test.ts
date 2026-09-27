import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbDocPreview from '@/components/knowledgeBase/KbDocPreview.vue'
import type { KBDoc } from '@/types/knowledgeBase'

/**
 * 文档标签页展示的是**原文**。
 *
 * 四条不变式：
 *
 * 1. 文本类文档按原文渲染，**不是切片**；
 * 2. 二进制类（PDF / 图片）走对象地址交给对应的文档组件；
 * 3. 原文里的 HTML **只能以字面量出现**——知识库文档是用户上传的任意内容，
 *    渲染原始 markdown 时漏了转义就是一条存储型 XSS；
 * 4. 拉不到原文要说原因并能重试，不能只留一片空白。
 */

const api = vi.hoisted(() => ({
  fetchDocumentBlob: vi.fn(),
  downloadDocument: vi.fn(),
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '操作失败')),
}))
vi.mock('@/services/knowledgeBaseApi', () => api)

/** jsdom 不实现 createObjectURL */
const createObjectURL = vi.fn(() => 'blob:mock-url')
const revokeObjectURL = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })

function makeDoc(overrides: Partial<KBDoc> = {}): KBDoc {
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

/** 原文内容按文本读时走 blob.text() */
function textBlob(content: string) {
  return { text: async () => content } as unknown as Blob
}

async function mountPreview(doc: KBDoc, content = '') {
  api.fetchDocumentBlob.mockResolvedValue(
    doc.name.endsWith('.pdf') ? ({} as Blob) : textBlob(content),
  )
  const wrapper = mount(KbDocPreview, {
    props: { kbId: 'kb-1', doc },
    global: { stubs: { KbDocDetailDrawer: true } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  api.fetchDocumentBlob.mockReset()
  api.downloadDocument.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
})

describe('KbDocPreview · 原文', () => {
  it('Markdown 按原文渲染出内容与格式', async () => {
    const wrapper = await mountPreview(makeDoc(), '# 第一章\n\n正文一段。')
    const html = wrapper.find('.markdown-preview').html()
    expect(html).toContain('<h1>第一章</h1>')
    expect(html).toContain('正文一段。')
    // 切片视图里才有的东西不该出现
    expect(wrapper.text()).not.toContain('分片')
  })

  it('原文里的 HTML 被转义，不会当成标签执行', async () => {
    const wrapper = await mountPreview(
      makeDoc(), '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>',
    )
    const html = wrapper.find('.markdown-preview').html()
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
  })

  it('纯文本按文本渲染', async () => {
    const wrapper = await mountPreview(makeDoc({ name: 'notes.txt', type: 'md' }), '一行文本')
    expect(wrapper.find('.text-viewer').text()).toBe('一行文本')
  })

  it('PDF 走对象地址，交给 PDF 阅读器', async () => {
    const wrapper = await mountPreview(makeDoc({ name: '手册.pdf', type: 'pdf' }))
    expect(createObjectURL).toHaveBeenCalled()
    const embed = wrapper.find('embed')
    expect(embed.exists()).toBe(true)
    expect(embed.attributes('src')).toBe('blob:mock-url')
  })

  it('Word 这类还没接预览的类型，直说并给下载入口', async () => {
    const wrapper = await mountPreview(makeDoc({ name: '方案.docx', type: 'docx' }), '')
    expect(wrapper.text()).toContain('暂不支持在线预览')
    await wrapper.find('.hint-btn').trigger('click')
    expect(api.downloadDocument).toHaveBeenCalledWith('kb-1', 'doc-1', '方案.docx')
  })

  it('文件名没有扩展名时用知识库记录的类型兜底（图片仍能显示）', async () => {
    const wrapper = await mountPreview(makeDoc({ name: 'screenshot', type: 'image' }))
    expect(wrapper.find('img').exists()).toBe(true)
  })
})

describe('KbDocPreview · 加载失败', () => {
  it('把后端给的原因显示出来，并能重试', async () => {
    api.fetchDocumentBlob.mockRejectedValueOnce(new Error('文档不存在'))
    const wrapper = mount(KbDocPreview, {
      props: { kbId: 'kb-1', doc: makeDoc() },
      global: { stubs: { KbDocDetailDrawer: true } },
    })
    await flushPromises()
    expect(wrapper.find('.hint-error').text()).toBe('文档不存在')

    api.fetchDocumentBlob.mockResolvedValueOnce(textBlob('# 好了'))
    await wrapper.find('.hint-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.markdown-preview').html()).toContain('好了')
  })

  it('卸载时释放对象地址，不漏内存', async () => {
    const wrapper = await mountPreview(makeDoc({ name: '图.png', type: 'image' }))
    wrapper.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })
})

describe('KbDocPreview · 原文 / 切片切换', () => {
  it('默认是原文视图', async () => {
    const wrapper = await mountPreview(makeDoc(), '# 标题')
    expect(wrapper.find('.markdown-preview').exists()).toBe(true)
    const pressed = wrapper.findAll('.preview-action').filter(
      (b) => b.attributes('aria-pressed') === 'true',
    )
    expect(pressed[0].attributes('title')).toBe('原文')
  })

  it('切到切片后渲染切片详情（原有能力没有被删掉）', async () => {
    const wrapper = await mountPreview(makeDoc(), '# 标题')
    const chunksBtn = wrapper.findAll('.preview-action').find(
      (b) => b.attributes('title') === '切片',
    )
    await chunksBtn!.trigger('click')
    expect(wrapper.findComponent({ name: 'KbDocDetailDrawer' }).exists()).toBe(true)
    expect(wrapper.find('.markdown-preview').exists()).toBe(false)
  })
})
