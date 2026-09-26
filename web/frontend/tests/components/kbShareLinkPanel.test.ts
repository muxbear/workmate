import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbShareLinkPanel from '@/components/knowledgeBase/KbShareLinkPanel.vue'

/**
 * 链接分享面板（迭代 6 T6.3）。
 *
 * 三条与"直觉相反或容易漏"的行为：
 *
 * 1. **明文链接只显示一次**——服务端只存摘要，创建响应是唯一机会，所以要把完整
 *    URL 摆出来并提供复制，而不是"创建成功"一句话就完了；
 * 2. **撤销的确认文案必须写明"已加入的人不会被移除"**——否则库主会以为撤销等于
 *    收回访问权，这是这个功能最容易误解的地方；
 * 3. URL 由**前端**用当前 origin 拼（后端不知道自己的公网地址）。
 */

const confirmSpy = vi.hoisted(() => vi.fn())
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const box = actual.ElMessageBox as Record<string, unknown>
  return { ...actual, ElMessageBox: { ...box, confirm: confirmSpy } }
})

const store = vi.hoisted(() => ({
  docQuery: { page: 1, pageSize: 20, total: 0, search: '', loading: false },
  loadDocs: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
  createShareLink: vi.fn(),
  loadShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', () => ({ useKnowledgeBaseStore: () => store }))

const api = vi.hoisted(() => ({
  readApiError: vi.fn((e: unknown) => (e instanceof Error ? e.message : '操作失败')),
}))
vi.mock('@/services/knowledgeBaseApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/services/knowledgeBaseApi')
  return { ...actual, ...api }
})

async function mountPanel() {
  const wrapper = mount(KbShareLinkPanel, {
    props: { kbId: 'kb-1', visible: false },
    global: {
      // el-select/el-radio 在 jsdom 里会因弹层定位触发递归更新（未捕获错误会污染
      // 整轮测试）。这里只断言"创建按钮、链接列表、撤销确认"，控件本身用 stub 隔离；
      // 非默认权限/有效期的传递在 store 层用例里断言（那里是确定性的）
      stubs: {
        teleport: true,
        'el-select': { template: '<div class="stub-select"><slot /></div>' },
        'el-option': true,
        'el-radio-group': { template: '<div class="stub-radio"><slot /></div>' },
        'el-radio': { template: '<label><slot /></label>' },
      },
    },
  })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  store.loadShareLinks.mockResolvedValue([])
})

describe('KbShareLinkPanel', () => {
  it('创建后把完整 URL 显示出来（明文只出现一次）', async () => {
    store.createShareLink.mockResolvedValue({
      id: 'l1', token: 'tok-abc', path: '/share/kb/tok-abc',
      permission: 'read', expiresAt: null,
    })
    const wrapper = await mountPanel()

    await wrapper.find('.btn-create').trigger('click')
    await flushPromises()

    const input = wrapper.find('.fresh-input').element as HTMLInputElement
    expect(input.value).toBe(`${window.location.origin}/share/kb/tok-abc`)
    expect(wrapper.text()).toContain('只在这里显示一次')
  })

  it('创建时带上所选的权限与有效期，默认只读 + 永久', async () => {
    store.createShareLink.mockResolvedValue({
      id: 'l1', token: 't', path: '/share/kb/t', permission: 'read', expiresAt: null,
    })
    const wrapper = await mountPanel()

    await wrapper.find('.btn-create').trigger('click')
    await flushPromises()

    expect(store.createShareLink).toHaveBeenCalledWith('kb-1', {
      permission: 'read', expiresIn: 'never',
    })
  })

  it('撤销确认框写明"已加入的人不会被移除"', async () => {
    store.loadShareLinks.mockResolvedValue([{
      id: 'l1', permission: 'read', expiresAt: null, revokedAt: null,
      acceptCount: 3, lastAcceptedAt: null, createdAt: '2026-09-26T10:00:00',
      state: 'active',
    }])
    confirmSpy.mockResolvedValue('confirm')
    const wrapper = await mountPanel()

    await wrapper.find('.link-revoke').trigger('click')
    await flushPromises()

    const message = String(confirmSpy.mock.calls[0][0])
    expect(message).toContain('3 人不会被移除')
    expect(store.revokeShareLink).toHaveBeenCalledWith('kb-1', 'l1')
  })

  it('取消确认则不调用撤销', async () => {
    store.loadShareLinks.mockResolvedValue([{
      id: 'l1', permission: 'read', expiresAt: null, revokedAt: null,
      acceptCount: 0, lastAcceptedAt: null, createdAt: '2026-09-26T10:00:00',
      state: 'active',
    }])
    confirmSpy.mockRejectedValue(new Error('cancel'))
    const wrapper = await mountPanel()

    await wrapper.find('.link-revoke').trigger('click')
    await flushPromises()

    expect(store.revokeShareLink).not.toHaveBeenCalled()
  })

  it('已撤销/已过期的链接不再提供撤销入口，并显示状态', async () => {
    store.loadShareLinks.mockResolvedValue([{
      id: 'l1', permission: 'read', expiresAt: '2026-09-01T00:00:00', revokedAt: null,
      acceptCount: 1, lastAcceptedAt: null, createdAt: '2026-08-01T10:00:00',
      state: 'expired',
    }])
    const wrapper = await mountPanel()

    expect(wrapper.text()).toContain('已过期')
    expect(wrapper.find('.link-revoke').exists()).toBe(false)
  })
})
