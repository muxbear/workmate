import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick, ref } from 'vue'
import KbGroupList from '@/components/knowledgeBase/KbGroupList.vue'
import type { KB } from '@/types/knowledgeBase'

/**
 * 「查看更多」页（某个栏目的全量列表）。
 *
 * 这里锁三件事：
 *
 * 1. **拖动排序的开放条件**（动作本身在 tests/composables/useCardDragSort.test.ts）：
 *    后端只在 scope=personal 时按手工顺序排，别的栏目里拖出来的顺序刷新就没；检索时
 *    屏幕上的"相邻"也不是列表里的"相邻"；
 * 2. **卡片 / 列表两种视图**切的是同一份数据；
 * 3. **分页**：能走服务端的走服务端，「共享给我的」「我的共享」是客户端过滤的，
 *    就在本地切页——不然攒到几十个库只能从头滚到尾。
 */

const store = vi.hoisted(() => ({
  groups: {} as Record<string, {
    items: KB[]; total: number; page: number; pageSize: number
    loading: boolean; loaded: boolean
  }>,
  // 由 mock 工厂填成真 ref（普通对象不是响应式的，切视图不会重渲染）
  viewMode: null as unknown as { value: 'grid' | 'list' },
  selectKb: vi.fn(),
  reorderKbs: vi.fn(),
  loadGroup: vi.fn(),
  kbGroups: [] as unknown[],
  togglePin: vi.fn(),
  updateKb: vi.fn(),
  assignGroup: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/stores/knowledgeBase')
  const { ref } = await import('vue')
  const viewMode = ref<'grid' | 'list'>('grid')
  store.viewMode = viewMode
  return {
    ...actual,
    useKnowledgeBaseStore: () => ({
      ...store,
      // 视图偏好是 store 上的真 ref：用 getter/setter 透出去，切换才驱动得了渲染
      get viewMode() { return viewMode.value },
      set viewMode(value: 'grid' | 'list') { viewMode.value = value },
    }),
  }
})

const CONFIG = {
  chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
  embeddingModel: 'text-embedding-v4', embeddingProviderId: '', embeddingDim: 1024,
  sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
  entityModel: '', relationModel: '', enableGraph: true,
  rerankerModel: '', rerankerProviderId: '', enableReranker: true,
  topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
  maxChunksPerDoc: 3, dedupSimilarity: 0.92,
  enableOcr: false, ocrModel: '', ocrProviderId: '',
  parentChunkSize: 1536, minChunkSize: 32,
  enableQueryRewrite: false, enableHyde: false,
} as KB['config']

function makeKb(id: string, name: string, isPinned = false): KB {
  return {
    id, name, description: '', status: 'ready',
    docs: 1, chunks: 1, entities: 0, relations: 0, size: '1 KB',
    updatedAt: '2026-09-26', config: CONFIG,
    documents: [], entitiesData: [], relationsData: [], tags: [],
    visibility: 'private', isOwner: true, ownerName: null,
    isPinned, sortOrder: 0, groupId: null,
  }
}

function setGroup(scope: string, items: KB[], total = items.length) {
  store.groups[scope] = {
    items, total, page: 1, pageSize: 12, loading: false, loaded: true,
  }
}

/** jsdom 没有 DragEvent：用 MouseEvent 造一个够用的（组件只读 clientX/Y） */
function dragEvent(type: string, pos: { x?: number; y?: number } = {}): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: pos.x ?? 0,
    clientY: pos.y ?? 0,
  })
}

/** 分页条换成"每页一个按钮"的桩：点得动，才测得了翻页 */
const PaginationStub = defineComponent({
  name: 'ElPagination',
  props: {
    total: { type: Number, default: 0 },
    pageSize: { type: Number, default: 12 },
    currentPage: { type: Number, default: 1 },
  },
  emits: ['current-change'],
  template: `
    <div class="stub-pager">
      <button
        v-for="p in Math.ceil(total / pageSize)"
        :key="p"
        @click="$emit('current-change', p)"
      >{{ p }}</button>
    </div>
  `,
})

function mountList(scope: 'personal' | 'public' | 'sharedByMe' | 'sharedWithMe') {
  return mount(KbGroupList, {
    props: { scope },
    global: {
      stubs: {
        teleport: true,
        'el-dropdown': { template: '<div><slot /></div>' },
        'el-dropdown-menu': true,
        'el-dropdown-item': true,
        'el-dialog': true,
        'el-pagination': PaginationStub,
      },
    },
  })
}

/** 翻到第 n 页：分页桩里第 n 个按钮 */
async function gotoPage(wrapper: ReturnType<typeof mountList>, n: number) {
  await wrapper.findAll('.stub-pager button')[n - 1].trigger('click')
  await flushPromises()
}

describe('KbGroupList · 拖动排序的开放条件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    store.groups = {}
    store.viewMode.value = 'grid'
    setGroup('personal', [makeKb('kb-1', '产品手册'), makeKb('kb-2', '运维手册')])
    setGroup('public', [makeKb('kb-3', '公共手册')])
  })

  it('个人知识库页：卡片可拖（draggable）并显示抓手与提示', async () => {
    const wrapper = mountList('personal')
    await flushPromises()

    expect(wrapper.find('[data-sort-area]').exists()).toBe(true)
    expect(wrapper.get('[data-card-id="kb-1"]').attributes('draggable')).toBe('true')
    expect(wrapper.find('[data-card-id="kb-1"] .kb-drag-handle').exists()).toBe(true)
    expect(wrapper.text()).toContain('拖动卡片可调整顺序')
  })

  it('其它栏目（顺序不由我决定）不开放拖动', async () => {
    const wrapper = mountList('public')
    await flushPromises()

    expect(wrapper.get('[data-card-id="kb-3"]').attributes('draggable')).toBe('false')
    expect(wrapper.find('.kb-drag-handle').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('拖动卡片可调整顺序')
  })

  it('检索中不开放拖动（屏幕上的相邻≠列表里的相邻）', async () => {
    const wrapper = mountList('personal')
    await flushPromises()

    await wrapper.get('.search-input').setValue('手册')

    expect(wrapper.get('[data-card-id="kb-1"]').attributes('draggable')).toBe('false')
  })

  it('卡片拖拽：dragstart → dragover 定落点 → drop 按新顺序落库', async () => {
    const wrapper = mountList('personal')
    await flushPromises()

    const source = wrapper.get('[data-card-id="kb-1"]')
    const target = wrapper.get('[data-card-id="kb-2"]')
    // jsdom 没有排版：给落点目标一个假盒子（100x100），右半区=落在其后
    ;(target.element as HTMLElement).getBoundingClientRect = () => ({
      left: 0, top: 0, width: 100, height: 100,
      right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)

    source.element.dispatchEvent(dragEvent('dragstart'))
    target.element.dispatchEvent(dragEvent('dragover', { x: 75, y: 50 }))
    await nextTick()

    expect(target.classes()).toContain('kb-card--drop-after')

    target.element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(store.reorderKbs).toHaveBeenCalledWith(['kb-2', 'kb-1'])
  })
})

describe('KbGroupList · 卡片 / 列表两种视图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    store.groups = {}
    store.viewMode.value = 'grid'
    setGroup('personal', [
      makeKb('kb-1', '产品手册'), makeKb('kb-2', '运维手册'), makeKb('kb-3', '测试手册', true),
    ])
  })

  it('默认卡片视图，切到列表后渲染同一份数据', async () => {
    const wrapper = mountList('personal')
    await flushPromises()
    expect(wrapper.find('.kb-grid').exists()).toBe(true)

    await wrapper.findAll('.view-btn')[1].trigger('click')

    expect(wrapper.find('.kb-grid').exists()).toBe(false)
    expect(wrapper.findAll('.kb-list-row')).toHaveLength(3)
    expect(wrapper.find('.kb-list-row[data-card-id="kb-2"]').text()).toContain('运维手册')
  })

  it('列表视图同样能拖动排序（同一条原生拖拽链路）', async () => {
    const wrapper = mountList('personal')
    await flushPromises()
    await wrapper.findAll('.view-btn')[1].trigger('click')

    expect(wrapper.get('.kb-list-row[data-card-id="kb-1"]').attributes('draggable')).toBe('true')
    expect(wrapper.find('.kb-list-row[data-card-id="kb-1"] .kb-drag-handle').exists()).toBe(true)
    expect(wrapper.text()).toContain('拖动卡片可调整顺序')
  })
})

describe('KbGroupList · 分页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    store.groups = {}
    store.viewMode.value = 'grid'
  })

  it('服务端分页的栏目：翻页去请求对应页', async () => {
    setGroup('public', Array.from({ length: 12 }, (_, i) => makeKb(`kb-${i}`, `库${i}`)), 30)
    const wrapper = mountList('public')
    await flushPromises()

    await gotoPage(wrapper, 2)

    expect(store.loadGroup).toHaveBeenCalledWith('public', 2)
  })

  it('客户端过滤的栏目：本地切页，不重复请求', async () => {
    // 15 个库、每页 12：第一页 12 张，第二页剩下 3 张
    setGroup('sharedWithMe', Array.from({ length: 15 }, (_, i) => makeKb(`kb-${i}`, `库${i}`)))
    const wrapper = mountList('sharedWithMe')
    await flushPromises()

    expect(wrapper.findAll('.kb-card')).toHaveLength(12)

    await gotoPage(wrapper, 2)

    expect(wrapper.findAll('.kb-card')).toHaveLength(3)
    expect(store.loadGroup).not.toHaveBeenCalled()
  })

  it('不足一页时不显示分页条', async () => {
    setGroup('public', [makeKb('kb-1', '只有一个')], 1)
    const wrapper = mountList('public')
    await flushPromises()

    expect(wrapper.find('.stub-pager').exists()).toBe(false)
  })
})
