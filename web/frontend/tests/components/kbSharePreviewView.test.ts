import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbSharePreviewView from '@/views/KbSharePreviewView.vue'
import type { KBShareLinkPreview } from '@/types/knowledgeBase'

/**
 * 链接分享落地页（迭代 6 T6.3）。
 *
 * 三条：
 *
 * 1. **未登录可看元信息**——只给一个登录页，收到链接的人不知道自己在点什么；
 *    页面上**没有正文**，匿名面到此为止；
 * 2. **接受需要登录**：未登录给"登录后接受"并带 redirect，已登录才调接受接口；
 * 3. **失效只有一种说法**：后端把"不存在/已撤销/已过期"统一成同一个 404，
 *    前端也照同一句话显示（区分等于告诉扫链接的人"这个 token 曾经有效"）。
 */

const push = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { token: 'tok-1' }, fullPath: '/share/kb/tok-1' }),
  useRouter: () => ({ push }),
}))

const auth = vi.hoisted(() => ({ isAuthenticated: false }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

const store = vi.hoisted(() => ({
  docQuery: { page: 1, pageSize: 20, total: 0, search: '', loading: false },
  loadDocs: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
  acceptShareLink: vi.fn() }))
vi.mock('@/stores/knowledgeBase', () => ({ useKnowledgeBaseStore: () => store }))

const api = vi.hoisted(() => ({ previewShareLink: vi.fn() }))
vi.mock('@/services/knowledgeBaseApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/services/knowledgeBaseApi')
  return { ...actual, ...api }
})

function preview(overrides: Partial<KBShareLinkPreview> = {}): KBShareLinkPreview {
  return {
    valid: true, kbName: '产品手册', description: '内部文档',
    docsCount: 12, chunksCount: 340, ownerName: '张三',
    permission: 'read', expiresAt: null,
    ...overrides,
  }
}

async function mountView() {
  const wrapper = mount(KbSharePreviewView, { global: { stubs: { teleport: true } } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.isAuthenticated = false
  api.previewShareLink.mockResolvedValue(preview())
})

describe('KbSharePreviewView', () => {
  it('未登录时显示元信息，并给"登录后接受"（带 redirect）', async () => {
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('产品手册')
    expect(wrapper.text()).toContain('12 篇文档')
    expect(wrapper.text()).toContain('登录后接受')

    await wrapper.find('.btn-primary').trigger('click')
    expect(push).toHaveBeenCalledWith({
      name: 'login', query: { redirect: '/share/kb/tok-1' },
    })
    expect(store.acceptShareLink).not.toHaveBeenCalled()
  })

  it('已登录时直接接受并跳转到知识库', async () => {
    auth.isAuthenticated = true
    store.acceptShareLink.mockResolvedValue({ accepted: true, already: false, permission: 'read' })
    const wrapper = await mountView()

    await wrapper.find('.btn-primary').trigger('click')
    await flushPromises()

    expect(store.acceptShareLink).toHaveBeenCalledWith('tok-1')
    expect(push).toHaveBeenCalledWith('/knowledge-base')
  })

  it('失效链接显示统一文案，不给任何操作入口', async () => {
    api.previewShareLink.mockRejectedValue(new Error('分享链接不存在或已失效'))
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('无法打开该分享')
    expect(wrapper.text()).toContain('分享链接不存在或已失效')
    expect(wrapper.find('.btn-primary').exists()).toBe(false)
  })

  it('可写分享在页面上标注出来', async () => {
    api.previewShareLink.mockResolvedValue(preview({ permission: 'write' }))
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('可写')
  })
})
