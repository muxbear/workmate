import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import KbDetail from '@/components/knowledgeBase/KbDetail.vue'
import KnowledgeBaseView from '@/views/KnowledgeBaseView.vue'
import type { KB } from '@/types/knowledgeBase'

/**
 * 知识库写操作的权限显隐（迭代 5 T5.1）。
 *
 * 权限有两条轴：资源归属（公共库 / 他人分享 → 只读）与**角色权限**。此前界面只看
 * 第一条，于是"访客"角色虽然没有任何 knowledge 权限键，按钮照样显示、点了才 403。
 * 这里锁住第二条轴：没有对应权限键时，按钮不得出现。
 */

// 权限判定可编程：各用例按需授予
const granted = ref<Set<string>>(new Set())
vi.mock('@/stores/permission', () => ({
  usePermissionStore: () => ({
    hasPermission: (key: string) => granted.value.has(key) || granted.value.has('*'),
  }),
}))

const storeMock = vi.hoisted(() => ({
  // 知识库页在挂载时会读这些（迭代 6 T6.2：分组 / 筛选 / 分页）
  kbs: [] as unknown[],
  kbGroups: [] as unknown[],
  tagFilter: '',
  groupFilter: '',
  kbTotal: 0,
  kbPage: 1,
  kbPageSize: 24,
  loadKbGroups: vi.fn(),
  setTagFilter: vi.fn(),
  setGroupFilter: vi.fn(),
  setKbPage: vi.fn(),
  createGroup: vi.fn(),
  selectedKb: null as unknown,
  groupKbs: [] as unknown[],
  loading: false,
  selectKb: vi.fn(),
  createKb: vi.fn(),
  deleteKb: vi.fn(),
  updateKb: vi.fn(),
  reindexKb: vi.fn(),
  uploadDocuments: vi.fn(),
  fetchKbs: vi.fn(),
  loadGroup: vi.fn(),
  loadAllGroups: vi.fn(),
  loadSharesByMe: vi.fn(),
  reset: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/stores/knowledgeBase')
  return {
    ...actual,
    // 用 getter 而不是 computed：computed 是**对象**、恒为真值，会让
    // `v-if="store.selectedKb"` 走进详情分支（真实 pinia store 会自动解包 ref，
    // 这里的替身没有那层代理，最容易踩的就是这个）
    useKnowledgeBaseStore: () => ({
      ...storeMock,
      get selectedKb() { return storeMock.selectedKb },
      // 统计卡直接读这些字段并 toLocaleString，字段名/类型不对会在渲染期抛错
      stats: { totalKbs: 1, totalDocs: 1, totalChunks: 10, totalEntities: 0, indexingCount: 0 },
      viewMode: 'grid',
      filteredKbs: [],
      activeNav: 'overview',
    }),
  }
})

const kbApi = vi.hoisted(() => ({ uploadDocuments: vi.fn(), deleteKb: vi.fn() }))
vi.mock('@/services/knowledgeBaseApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/services/knowledgeBaseApi')
  return { ...actual, ...kbApi }
})

function kb(overrides_: Partial<KB> = {}): KB {
  return {
    id: 'kb-1', name: '库', description: '', status: 'ready',
    docs: 1, chunks: 10, entities: 0, relations: 0, size: '1 KB',
    updatedAt: '2026-09-24',
    config: {
      chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
      embeddingModel: 'text-embedding-v4', embeddingProviderId: '',
      embeddingDim: 1024, sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
      entityModel: '', relationModel: '', enableGraph: true,
      rerankerModel: '', rerankerProviderId: '', enableReranker: true,
      topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
      maxChunksPerDoc: 3, dedupSimilarity: 0.92,
      parentChunkSize: 1536, minChunkSize: 32,
      enableQueryRewrite: false, enableHyde: false,
    },
    documents: [], entitiesData: [], relationsData: [], tags: [],
    visibility: 'private', isOwner: true, ownerName: null,
    access: 'owner',
    ...overrides_,
  }
}

/** 头部的**可见按钮**文本——对话框（隐藏的 el-overlay）里也有同名文字，
 *  按 HTML 文本断言会误判，必须落在按钮元素上。 */
function headerButtons(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.header-actions button').map((b) => b.text())
}

async function mountDetail() {
  storeMock.selectedKb = kb()
  const wrapper = mount(KbDetail, {
    props: { kb: kb() },
    global: { stubs: { RouterLink: true } },
  })
  await flushPromises()
  return wrapper
}

describe('KbDetail · 头部写操作按角色权限显隐', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    granted.value = new Set()
  })

  it('拥有 edit 与 delete 时显示全部写操作', async () => {
    granted.value = new Set(['knowledge:edit', 'knowledge:delete'])

    const wrapper = await mountDetail()

    expect(headerButtons(wrapper)).toContain('重新索引')
    expect(headerButtons(wrapper)).toContain('删除')
  })

  it('缺 knowledge:edit 时不显示重新索引与分享', async () => {
    granted.value = new Set(['knowledge:delete'])

    const wrapper = await mountDetail()

    expect(headerButtons(wrapper)).not.toContain('重新索引')
    expect(headerButtons(wrapper)).not.toContain('分享')
    expect(headerButtons(wrapper)).toContain('删除')
  })

  it('缺 knowledge:delete 时不显示删除，但编辑类仍在', async () => {
    granted.value = new Set(['knowledge:edit'])

    const wrapper = await mountDetail()

    expect(headerButtons(wrapper)).toContain('重新索引')
    expect(headerButtons(wrapper)).not.toContain('删除')
  })

  it('两个键都没有时不渲染操作区', async () => {
    granted.value = new Set()

    const wrapper = await mountDetail()

    expect(wrapper.find('.header-actions').exists()).toBe(false)
  })

  it('他人分享的库即使有权限也不显示写操作（资源归属轴仍然生效）', async () => {
    granted.value = new Set(['knowledge:edit', 'knowledge:delete'])
    storeMock.selectedKb = { ...kb(), isOwner: false }
    const wrapper = mount(KbDetail, {
      props: { kb: { ...kb(), isOwner: false } },
      global: { stubs: { RouterLink: true } },
    })
    await flushPromises()

    expect(wrapper.find('.header-actions').exists()).toBe(false)
  })
})

describe('KnowledgeBaseView · 建库入口按权限显隐', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    granted.value = new Set()
    storeMock.selectedKb = null
  })

  async function mountView() {
    const wrapper = mount(KnowledgeBaseView, {
      global: { stubs: { RouterLink: true, KbSidebar: true, KbDetail: true } },
    })
    await flushPromises()
    return wrapper
  }

  it('无 knowledge:create 时不显示新建入口', async () => {
    const wrapper = await mountView()

    expect(wrapper.find('.btn-create').exists()).toBe(false)
    expect(wrapper.find('.create-card').exists()).toBe(false)
  })

  it('有 knowledge:create 时显示新建入口', async () => {
    granted.value = new Set(['knowledge:create'])

    const wrapper = await mountView()

    expect(wrapper.find('.btn-create').exists()).toBe(true)
  })
})

describe('KbDetail · 访问级别决定文档页签可写性（迭代 6 T6.3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    granted.value = new Set(['knowledge:upload'])
  })

  async function mountWithAccess(access: 'owner' | 'write' | 'read') {
    storeMock.selectedKb = kb({ access, isOwner: access === 'owner' })
    const wrapper = mount(KbDetail, {
      props: { kb: kb({ access, isOwner: access === 'owner' }) },
      global: { stubs: { RouterLink: true } },
    })
    await flushPromises()
    return wrapper
  }

  it('可写分享者：文档页签可编辑（能上传/删改切片）', async () => {
    const KbDocsTab = (await import('@/components/knowledgeBase/KbDocsTab.vue')).default

    const wrapper = await mountWithAccess('write')

    const docsTab = wrapper.findComponent(KbDocsTab)
    expect(docsTab.exists()).toBe(true)
    expect(docsTab.props('readonly')).toBe(false)
  })

  it('只读分享者：文档页签仍是只读', async () => {
    const KbDocsTab = (await import('@/components/knowledgeBase/KbDocsTab.vue')).default

    const wrapper = await mountWithAccess('read')

    expect(wrapper.findComponent(KbDocsTab).props('readonly')).toBe(true)
  })

  it('可写分享者仍进不了配置页签（改配置会改变所有人的检索语义）', async () => {
    const KbConfigTab = (await import('@/components/knowledgeBase/KbConfigTab.vue')).default

    const wrapper = await mountWithAccess('write')

    expect(wrapper.findComponent(KbConfigTab).props('readonly')).toBe(true)
  })
})
