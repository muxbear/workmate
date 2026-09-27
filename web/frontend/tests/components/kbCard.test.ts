import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import KbCard from '@/components/knowledgeBase/KbCard.vue'
import KbEditDialog from '@/components/knowledgeBase/KbEditDialog.vue'
import type { KB } from '@/types/knowledgeBase'

/**
 * 知识库卡片的组织操作入口（迭代 6 T6.2）。
 *
 * 关键不变式：**只有库主能整理自己的列表**——置顶/编辑/复制表达的是"我的视图
 * 偏好"，公共库与他人分享的库上不该出现这些入口（后端也会拒）。
 *
 * 菜单里的各个动作由 store 用例覆盖（见 tests/stores/knowledgeBase.test.ts）；
 * 这里不挂真实的 el-dropdown 弹层——它在 jsdom 下会触发递归更新，且弹层定位是
 * Element Plus 自己的渲染。改用只渲染插槽的桩：不测第三方组件，但**菜单项本身
 * 进得了 DOM**，这样"哪些项在、哪些项不在"才断言得到。
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
  template: '<div class="stub-item"><slot /></div>',
})

const store = vi.hoisted(() => ({
  docQuery: { page: 1, pageSize: 20, total: 0, search: '', loading: false },
  loadDocs: vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 })),
  kbGroups: [] as unknown[],
  togglePin: vi.fn(),
  moveKb: vi.fn(),
  copyKb: vi.fn(),
  exportKb: vi.fn(),
  assignGroup: vi.fn(),
  updateKb: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', () => ({ useKnowledgeBaseStore: () => store }))

const CONFIG = {
  chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
  embeddingModel: '', embeddingProviderId: '', embeddingDim: 1024,
  sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
  entityModel: '', relationModel: '', enableGraph: true,
  rerankerModel: '', rerankerProviderId: '', enableReranker: true,
  topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
  maxChunksPerDoc: 3, dedupSimilarity: 0.92,
  enableOcr: false, ocrModel: '', ocrProviderId: '',
  parentChunkSize: 1536, minChunkSize: 32,
  enableQueryRewrite: false, enableHyde: false,
} as KB['config']

function makeKb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1', name: '产品手册', description: '', status: 'ready',
    docs: 1, chunks: 1, entities: 0, relations: 0, size: '1 KB',
    updatedAt: '2026-09-26', config: CONFIG,
    documents: [], entitiesData: [], relationsData: [], tags: [],
    visibility: 'private', isOwner: true, ownerName: null,
    isPinned: false, sortOrder: 0, groupId: null,
    ...overrides,
  }
}

function mountCard(overrides: Partial<KB> = {}, readonly = false) {
  return mount(KbCard, {
    props: { kb: makeKb(overrides), readonly },
    global: {
      // el-dropdown / el-dialog 在 jsdom 里会因弹层定位触发递归更新（未捕获错误会
      // 污染整轮测试）。这里只断言"入口按钮在不在"，弹层用 stub 隔离。
      stubs: {
        teleport: true,
        // 两个插槽都渲染：触发器（默认插槽）与菜单项（dropdown 插槽）
        'el-dropdown': DropdownStub,
        'el-dropdown-menu': DropdownMenuStub,
        'el-dropdown-item': DropdownItemStub,
        'el-dialog': true,
      },
    },
  })
}

/** 卡片的操作菜单（命令靠 el-dropdown 的 command 事件回抛） */
function cardMenu(wrapper: ReturnType<typeof mountCard>) {
  return wrapper.findAllComponents(DropdownStub)[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  store.kbGroups = []
})

describe('KbCard · 组织操作入口', () => {
  it('库主可见操作菜单', () => {
    const wrapper = mountCard()

    expect(wrapper.find('.card-menu-btn').exists()).toBe(true)
  })

  it('只读态不显示操作菜单', () => {
    const wrapper = mountCard({ isOwner: false }, true)

    expect(wrapper.find('.card-menu-btn').exists()).toBe(false)
  })

  it('概览页（hideMenu）不显示操作菜单，整顿操作只在「查看更多」里做', () => {
    const wrapper = mount(KbCard, {
      props: { kb: makeKb(), hideMenu: true },
      global: { stubs: { teleport: true, 'el-dialog': true } },
    })

    expect(wrapper.find('.card-menu-btn').exists()).toBe(false)
  })

  it('他人的库（非库主）即使非只读也不显示', () => {
    const wrapper = mountCard({ isOwner: false })

    expect(wrapper.find('.card-menu-btn').exists()).toBe(false)
  })

  it('置顶的库显示置顶标记', () => {
    const wrapper = mountCard({ isPinned: true })

    expect(wrapper.text()).toContain('置顶')
  })

  it('菜单项：置顶 / 重命名 / 编辑 / 复制 / 导出配置', () => {
    const menu = cardMenu(mountCard()).text()

    expect(menu).toContain('置顶')
    expect(menu).toContain('重命名')
    expect(menu).toContain('编辑')
    expect(menu).toContain('复制（含配置）')
    expect(menu).toContain('导出配置')
  })

  it('菜单项里不再有上移 / 下移 / 归入分组', () => {
    // 排序改成「查看更多」页长按拖动；分组归属并入「编辑」弹窗
    const menu = cardMenu(mountCard()).text()

    expect(menu).not.toContain('上移')
    expect(menu).not.toContain('下移')
    expect(menu).not.toContain('归入分组')
  })

  it('选中「编辑」打开编辑弹窗', async () => {
    const wrapper = mountCard()

    expect(wrapper.findComponent(KbEditDialog).props('visible')).toBe(false)

    cardMenu(wrapper).vm.$emit('command', 'edit')
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(KbEditDialog).props('visible')).toBe(true)
  })

  it('切到英文后渲染英文文案（真双语的端到端验证）', async () => {
    // 前面都是断言中文——那些断言能过是因为 zh-CN 仍是默认语言、渲染结果逐字未变。
    // 这条换到英文，证明迁移过的文案**确实跟着语言走**，而不是把中文写进了 key。
    const i18n = (await import('@/locales')).default
    const original = i18n.global.locale.value
    try {
      i18n.global.locale.value = 'en'
      const wrapper = mountCard()
      const text = wrapper.text()
      expect(text).toContain('Knowledge graph')
      expect(text).not.toContain('知识图谱')
    } finally {
      i18n.global.locale.value = original
    }
  })
})
