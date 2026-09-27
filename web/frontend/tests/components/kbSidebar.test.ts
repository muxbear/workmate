import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import KbSidebar from '@/components/knowledgeBase/KbSidebar.vue'
import type { KB, KBShare } from '@/types/knowledgeBase'

/**
 * 左栏知识库行的「三点 → 查看详情」。
 *
 * 为什么入口必须**每个分组**都有：详情页的"概览"页签已经去掉，看统计/标签/索引方案
 * 只剩这个入口。只挂在个人知识库上的话，公共库与分享来的库就再没有概览可看。
 *
 * 与 kbCard 用例同款：不挂真实的 el-dropdown 弹层（jsdom 下会触发递归更新），
 * 用只渲染插槽的桩——菜单项本身仍进 DOM，"哪些项在"才断言得到。
 */

const DropdownStub = defineComponent({
  name: 'ElDropdown',
  emits: ['command'],
  template: '<div class="stub-dropdown"><slot /><slot name="dropdown" /></div>',
})
const DropdownMenuStub = defineComponent({
  name: 'ElDropdownMenu',
  template: '<div class="stub-menu"><slot /></div>',
})
const DropdownItemStub = defineComponent({
  name: 'ElDropdownItem',
  props: { command: { type: String, default: '' } },
  template: '<div class="stub-item" :data-command="command"><slot /></div>',
})

const store = vi.hoisted(() => ({
  invitations: [] as KBShare[],
  pendingInvitationCount: 0,
  selectedKb: null as KB | null,
  activeNav: 'overview',
  groupExpanded: { public: true, personal: true, sharedByMe: true, sharedWithMe: true },
  groupPreview: vi.fn(() => [] as KB[]),
  groupHasMore: vi.fn(() => false),
  groups: {} as Record<string, { total: number } | undefined>,
  setActiveNav: vi.fn(),
  selectKb: vi.fn(),
  clearSelection: vi.fn(),
  fetchKbs: vi.fn(),
  toggleGroup: vi.fn(),
  respondInvitation: vi.fn(),
}))

vi.mock('@/stores/knowledgeBase', () => ({
  useKnowledgeBaseStore: () => store,
  // 分组定义由组件消费；这里给一份最小的，分组 id 与生产一致
  KB_GROUPS: [
    { id: 'public', label: '公共知识库' },
    { id: 'personal', label: '个人知识库' },
    { id: 'sharedByMe', label: '我的共享知识' },
    { id: 'sharedWithMe', label: '共享给我的' },
  ],
}))

vi.mock('@/composables/useKbPermissions', () => ({
  useKbPermissions: () => ({ canCreate: true, canEdit: true, canUpload: true, canDelete: true }),
}))

function makeKb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1',
    name: '产品手册',
    description: '',
    status: 'ready',
    docs: 1,
    chunks: 1,
    entities: 0,
    relations: 0,
    size: '1 KB',
    updatedAt: '2026-09-26',
    config: {} as KB['config'],
    documents: [],
    entitiesData: [],
    relationsData: [],
    tags: [],
    visibility: 'private',
    isOwner: true,
    ownerName: null,
    ...overrides,
  }
}

function mountSidebar() {
  return mount(KbSidebar, {
    global: {
      stubs: {
        teleport: true,
        'el-dropdown': DropdownStub,
        'el-dropdown-menu': DropdownMenuStub,
        'el-dropdown-item': DropdownItemStub,
        'el-tag': true,
      },
    },
  })
}

/**
 * 知识库**行**的三点菜单（分组头上也有一个三点，那个是「查看更多/新建知识库」）。
 *
 * 两者都是 el-dropdown，靠"子树里有没有 `.kb-lib-more`"区分——直接取第一个
 * `.stub-menu` 会拿到分组菜单，断言就变成了在测另一个东西。
 */
function rowDropdowns(wrapper: ReturnType<typeof mountSidebar>) {
  return wrapper.findAllComponents(DropdownStub).filter((d) => d.find('.kb-lib-more').exists())
}

function rowMenuText(wrapper: ReturnType<typeof mountSidebar>) {
  return rowDropdowns(wrapper).map((d) => d.find('.stub-menu').text())
}

beforeEach(() => {
  vi.clearAllMocks()
  store.invitations = []
  store.groups = {}
  store.groupPreview.mockReturnValue([])
})

describe('KbSidebar · 知识库行的三点菜单', () => {
  it('个人知识库的每一项都有三点按钮与「查看详情」', () => {
    store.groupPreview.mockReturnValue([makeKb({ id: 'kb-1', name: '产品手册' })])

    const wrapper = mountSidebar()

    expect(wrapper.find('.kb-lib-more').exists()).toBe(true)
    expect(rowMenuText(wrapper)[0]).toContain('查看详情')
  })

  it('公共知识库同样有「查看详情」（去掉概览页签后它是唯一入口）', () => {
    store.groupPreview.mockImplementation((groupId: string) =>
      groupId === 'public' ? [makeKb({ id: 'kb-pub', name: '公共库' })] : [],
    )

    const wrapper = mountSidebar()

    expect(wrapper.findAll('.kb-lib-more').length).toBeGreaterThan(0)
    expect(rowMenuText(wrapper)[0]).toContain('查看详情')
  })

  it('「共享给我的」里已接受的库也有', () => {
    store.invitations = [
      {
        id: 'share-1',
        kbId: 'kb-shared',
        kbName: '别人的库',
        userId: 'u2',
        username: null,
        nickname: '张三',
        avatar: '',
        status: 'accepted',
        permission: 'read',
        createdAt: '2026-09-26',
        acceptedAt: '2026-09-26',
      },
    ]

    const wrapper = mountSidebar()

    expect(rowMenuText(wrapper)[0]).toContain('查看详情')
  })

  it('选中「查看详情」时把 kbId 抛给父组件（父组件据此挂弹窗）', async () => {
    store.groupPreview.mockReturnValue([makeKb({ id: 'kb-1' })])
    const wrapper = mountSidebar()

    rowDropdowns(wrapper)[0].vm.$emit('command', 'detail')
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('view-detail')?.[0]).toEqual(['kb-1'])
  })

  it('「我的共享知识」在查看详情之外仍保留分享两项', () => {
    store.groupPreview.mockImplementation((groupId: string) =>
      groupId === 'sharedByMe' ? [makeKb({ id: 'kb-mine' })] : [],
    )

    const wrapper = mountSidebar()
    const menuText = rowMenuText(wrapper)[0]

    expect(menuText).toContain('查看详情')
    expect(menuText).toContain('查看已分享用户')
    expect(menuText).toContain('取消分享')
  })
})
