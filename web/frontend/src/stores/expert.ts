import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  Expert,
  ExpertCreateRequest,
  ExpertUpdateRequest,
  ExpertProfileUpdateRequest,
  ExpertConfigUpdateRequest,
  ExpertListParams,
  FeaturedScene,
} from '@/types/expert'
import * as expertApi from '@/services/expertApi'

/* ------------------------------------------------------------------ */
/*  Mock 数据（后端 API 实现后移除）                                    */
/* ------------------------------------------------------------------ */

const MOCK_EXPERTS: Expert[] = [
  {
    id: 'mock-1',
    name: '林晓雯',
    title: '内容创作专家',
    description: '擅长小红书种草内容、品牌故事撰写，已服务超过 300+ 品牌方。',
    category: 'content_creation',
    tags: ['小红书', '品牌文案'],
    icon: '',
    color: 'linear-gradient(135deg,#f59e0b,#d97706)',
    initials: '林',
    rating: 4.9,
    usageCount: 2100,
    featured: true,
    scene: 'content',
    sortOrder: 100,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位专业的内容创作专家，擅长小红书种草文案和品牌故事撰写。',
    providerId: 'p1',
    modelId: 'm1',
    tools: [
      { id: 't1', name: 'http_request', displayName: 'HTTP 请求', toolType: 'function', category: 'network', icon: '' },
    ],
    skills: [],
    mcpConfigs: [],
    files: ['AGENTS.md', 'SOUL.md'],
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-28T12:00:00Z',
  },
  {
    id: 'mock-2',
    name: '陈法鉴',
    title: '法律顾问专家',
    description: '10 年执业律师，专注商事合同审查与知识产权保护领域。',
    category: 'legal_tax',
    tags: ['合同审查', '公司法'],
    icon: '',
    color: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    initials: '陈',
    rating: 4.8,
    usageCount: 1700,
    featured: true,
    scene: 'legal',
    sortOrder: 90,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位资深法律顾问，专注于商事合同审查与知识产权保护。',
    providerId: 'p1',
    modelId: 'm1',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    createdAt: '2026-08-02T10:00:00Z',
    updatedAt: '2026-08-27T12:00:00Z',
  },
  {
    id: 'mock-3',
    name: 'Kira Zhang',
    title: '前端开发 & 设计',
    description: '全栈设计工程师，专注 React 生态与 Design System 落地。',
    category: 'tech_rnd',
    tags: ['React', 'Figma', 'Tailwind'],
    icon: '',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    initials: 'K',
    rating: 4.9,
    usageCount: 3400,
    featured: true,
    scene: 'invest',
    sortOrder: 80,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位全栈设计工程师，精通 React 生态与 Design System。',
    tools: [
      { id: 't2', name: 'execute_code', displayName: '代码执行', toolType: 'function', category: 'code', icon: '' },
    ],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-03T10:00:00Z',
    updatedAt: '2026-08-26T12:00:00Z',
  },
  {
    id: 'mock-4',
    name: '赵研究员',
    title: '行业信息研究员',
    description: '深度行业研究，覆盖消费、科技、新能源等十余个赛道。',
    category: 'spc',
    tags: ['市场调研', '竞品分析'],
    icon: '',
    color: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
    initials: '赵',
    rating: 4.7,
    usageCount: 980,
    featured: false,
    sortOrder: 70,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位行业信息研究员，擅长市场调研与竞品分析。',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-25T12:00:00Z',
  },
  {
    id: 'mock-5',
    name: '美团工程师',
    title: '美团前工程师',
    description: '曾任美团基础架构组 P7，擅长高并发系统设计与性能调优。',
    category: 'tech_rnd',
    tags: ['高并发', 'Go', '微服务'],
    icon: '',
    color: 'linear-gradient(135deg,#f97316,#ea580c)',
    initials: '美',
    rating: 4.8,
    usageCount: 2800,
    featured: false,
    sortOrder: 60,
    isPublished: true,
    status: 'inactive',
    systemPrompt: '你是一位资深后端工程师，专注于高并发系统设计。',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-05T10:00:00Z',
    updatedAt: '2026-08-24T12:00:00Z',
  },
  {
    id: 'mock-6',
    name: '周财税',
    title: '财务合伙人',
    description: 'CPA 注册会计师，专注中小企业税务筹划与融资前财务规划。',
    category: 'legal_tax',
    tags: ['税务筹划', '财务报告'],
    icon: '',
    color: 'linear-gradient(135deg,#10b981,#059669)',
    initials: '周',
    rating: 4.6,
    usageCount: 1200,
    featured: true,
    scene: 'legal',
    sortOrder: 50,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位资深财税专家，CPA 注册会计师。',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-06T10:00:00Z',
    updatedAt: '2026-08-23T12:00:00Z',
  },
  {
    id: 'mock-7',
    name: '沈产品',
    title: '资深产品经理',
    description: '前字节跳动产品负责人，主导过多款 DAU 千万级产品。',
    category: 'product_design',
    tags: ['0-1', '用户研究', 'PRD'],
    icon: '',
    color: 'linear-gradient(135deg,#06b6d4,#0891b2)',
    initials: '沈',
    rating: 4.9,
    usageCount: 4100,
    featured: false,
    sortOrder: 40,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一位资深产品经理，擅长 0-1 产品搭建与用户研究。',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-07T10:00:00Z',
    updatedAt: '2026-08-22T12:00:00Z',
  },
  {
    id: 'mock-8',
    name: '投研小组',
    title: '创投分析团队',
    description: '由 3 位前头部 VC 分析师组成，专注早期项目尽调与估值建模。',
    category: 'startup_invest',
    tags: ['VC', '尽调', '估值'],
    icon: '',
    color: 'linear-gradient(135deg,#ec4899,#db2777)',
    initials: '投',
    rating: 4.7,
    usageCount: 760,
    featured: false,
    sortOrder: 30,
    isPublished: true,
    status: 'active',
    systemPrompt: '你是一个创投分析团队，专注早期项目尽调与估值建模。',
    tools: [],
    skills: [],
    mcpConfigs: [],
    files: [],
    providerId: undefined,
    modelId: undefined,
    createdAt: '2026-08-08T10:00:00Z',
    updatedAt: '2026-08-21T12:00:00Z',
  },
]

const MOCK_SCENES: FeaturedScene[] = [
  {
    id: 'content',
    label: '内容创作',
    color: 'linear-gradient(135deg,#f59e0b,#d97706)',
    expertIds: ['mock-1'],
  },
  {
    id: 'invest',
    label: '投资分析',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    expertIds: ['mock-3'],
  },
  {
    id: 'legal',
    label: '法律财税',
    color: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    expertIds: ['mock-2', 'mock-6'],
  },
  {
    id: 'sme',
    label: '小微企业',
    color: 'linear-gradient(135deg,#10b981,#059669)',
    expertIds: [],
  },
]

/** 格式化使用次数 */
function formatUsageCount(count: number): string {
  if (count >= 10000) return (count / 1000).toFixed(1) + 'w'
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
  return String(count)
}

/** 使用 mock 数据模拟分页列表 */
function mockFetchExperts(params: ExpertListParams): Promise<{
  items: Expert[]
  total: number
  page: number
  pageSize: number
}> {
  return new Promise((resolve) => {
    setTimeout(() => {
      let list = [...MOCK_EXPERTS]
      if (params.keyword) {
        const kw = params.keyword.toLowerCase()
        list = list.filter(
          (e) =>
            e.name.toLowerCase().includes(kw) ||
            e.title.toLowerCase().includes(kw) ||
            e.description.toLowerCase().includes(kw) ||
            e.tags.some((t) => t.toLowerCase().includes(kw)),
        )
      }
      if (params.category) {
        list = list.filter((e) => e.category === params.category)
      }
      if (params.featured) {
        list = list.filter((e) => e.featured)
      }
      if (params.status) {
        list = list.filter((e) => e.status === params.status)
      }
      switch (params.sort) {
        case 'usage':
          list.sort((a, b) => b.usageCount - a.usageCount)
          break
        case 'recent':
          list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          break
        case 'name':
          list.sort((a, b) => a.name.localeCompare(b.name))
          break
        default:
          list.sort((a, b) => b.rating - a.rating)
      }
      const total = list.length
      const start = (params.page - 1) * params.pageSize
      const items = list.slice(start, start + params.pageSize)
      resolve({ items, total, page: params.page, pageSize: params.pageSize })
    }, 300)
  })
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

/** 后端 API 是否可用（首次请求失败后切换到 mock 模式） */
let useMock = false // 先用 mock，后端实现后改为 false

export const useExpertStore = defineStore('expert', () => {
  const experts = ref<Expert[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const searchQuery = ref('')
  const categoryFilter = ref<string>('')
  const sortBy = ref<'rating' | 'usage' | 'recent' | 'name'>('rating')
  const page = ref(1)
  const pageSize = ref(20)

  const featuredScenes = ref<FeaturedScene[]>(MOCK_SCENES)

  async function fetchExperts() {
    loading.value = true
    error.value = null
    try {
      if (useMock) {
        const result = await mockFetchExperts({
          page: page.value,
          pageSize: pageSize.value,
          keyword: searchQuery.value || undefined,
          category: categoryFilter.value || undefined,
          sort: sortBy.value,
        })
        experts.value = result.items
        total.value = result.total
      } else {
        const result = await expertApi.fetchExperts({
          page: page.value,
          pageSize: pageSize.value,
          keyword: searchQuery.value || undefined,
          category: categoryFilter.value || undefined,
          sort: sortBy.value,
        })
        experts.value = result.items
        total.value = result.total
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '加载专家列表失败'
    } finally {
      loading.value = false
    }
  }

  async function getExpert(id: string): Promise<Expert | null> {
    if (useMock) {
      return MOCK_EXPERTS.find((e) => e.id === id) || null
    }
    try {
      return await expertApi.getExpert(id)
    } catch {
      return null
    }
  }

  async function createExpert(data: ExpertCreateRequest): Promise<Expert> {
    if (useMock) {
      const newExpert: Expert = {
        id: 'mock-' + Date.now(),
        name: data.name,
        title: data.title,
        description: data.description,
        category: data.category,
        tags: data.tags,
        icon: data.icon,
        color: data.color,
        initials: data.initials,
        rating: 0,
        usageCount: 0,
        featured: data.featured,
        scene: data.scene,
        sortOrder: 0,
        isPublished: true,
        status: 'inactive',
        systemPrompt: data.systemPrompt,
        providerId: data.providerId,
        modelId: data.modelId,
        tools: [],
        skills: [],
        mcpConfigs: [],
        files: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      MOCK_EXPERTS.unshift(newExpert)
      await fetchExperts()
      return newExpert
    }
    const result = await expertApi.createExpert(data)
    await fetchExperts()
    return result
  }

  async function updateExpert(id: string, data: ExpertUpdateRequest): Promise<Expert> {
    if (useMock) {
      const idx = MOCK_EXPERTS.findIndex((e) => e.id === id)
      if (idx !== -1) {
        Object.assign(MOCK_EXPERTS[idx], {
          name: data.name,
          title: data.title,
          description: data.description,
          systemPrompt: data.systemPrompt,
          providerId: data.providerId,
          modelId: data.modelId,
          updatedAt: new Date().toISOString(),
        })
      }
      await fetchExperts()
      return MOCK_EXPERTS[idx] || MOCK_EXPERTS[0]
    }
    const result = await expertApi.updateExpert(id, data)
    await fetchExperts()
    return result
  }

  async function updateExpertProfile(id: string, data: ExpertProfileUpdateRequest): Promise<void> {
    if (useMock) {
      const idx = MOCK_EXPERTS.findIndex((e) => e.id === id)
      if (idx !== -1) {
        if (data.title !== undefined) MOCK_EXPERTS[idx].title = data.title
        if (data.category !== undefined) MOCK_EXPERTS[idx].category = data.category
        if (data.tags !== undefined) MOCK_EXPERTS[idx].tags = data.tags
        if (data.icon !== undefined) MOCK_EXPERTS[idx].icon = data.icon
        if (data.color !== undefined) MOCK_EXPERTS[idx].color = data.color
        if (data.initials !== undefined) MOCK_EXPERTS[idx].initials = data.initials
        if (data.featured !== undefined) MOCK_EXPERTS[idx].featured = data.featured
        if (data.scene !== undefined) MOCK_EXPERTS[idx].scene = data.scene
        if (data.sortOrder !== undefined) MOCK_EXPERTS[idx].sortOrder = data.sortOrder
        if (data.isPublished !== undefined) MOCK_EXPERTS[idx].isPublished = data.isPublished
        MOCK_EXPERTS[idx].updatedAt = new Date().toISOString()
      }
      await fetchExperts()
      return
    }
    await expertApi.updateExpertProfile(id, data)
    await fetchExperts()
  }

  async function updateExpertConfig(id: string, data: ExpertConfigUpdateRequest): Promise<void> {
    if (useMock) {
      const idx = MOCK_EXPERTS.findIndex((e) => e.id === id)
      if (idx !== -1) {
        if (data.systemPrompt !== undefined) MOCK_EXPERTS[idx].systemPrompt = data.systemPrompt
        if (data.providerId !== undefined) MOCK_EXPERTS[idx].providerId = data.providerId
        if (data.modelId !== undefined) MOCK_EXPERTS[idx].modelId = data.modelId
        MOCK_EXPERTS[idx].updatedAt = new Date().toISOString()
      }
      await fetchExperts()
      return
    }
    await expertApi.updateExpertConfig(id, data)
    await fetchExperts()
  }

  async function deleteExpert(id: string): Promise<void> {
    if (useMock) {
      const idx = MOCK_EXPERTS.findIndex((e) => e.id === id)
      if (idx !== -1) MOCK_EXPERTS.splice(idx, 1)
      await fetchExperts()
      return
    }
    await expertApi.deleteExpert(id)
    await fetchExperts()
  }

  async function toggleStatus(id: string): Promise<void> {
    if (useMock) {
      const idx = MOCK_EXPERTS.findIndex((e) => e.id === id)
      if (idx !== -1) {
        MOCK_EXPERTS[idx].status = MOCK_EXPERTS[idx].status === 'active' ? 'inactive' : 'active'
      }
      await fetchExperts()
      return
    }
    await expertApi.toggleExpertStatus(id)
    await fetchExperts()
  }

  async function cloneExpert(id: string): Promise<void> {
    if (useMock) {
      const src = MOCK_EXPERTS.find((e) => e.id === id)
      if (src) {
        const cloned: Expert = {
          ...src,
          id: 'mock-' + Date.now(),
          name: src.name + ' (副本)',
          status: 'inactive',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        MOCK_EXPERTS.unshift(cloned)
      }
      await fetchExperts()
      return
    }
    await expertApi.cloneExpert(id)
    await fetchExperts()
  }

  function resetPage() {
    page.value = 1
  }

  return {
    experts,
    total,
    loading,
    error,
    searchQuery,
    categoryFilter,
    sortBy,
    page,
    pageSize,
    featuredScenes,
    fetchExperts,
    getExpert,
    createExpert,
    updateExpert,
    updateExpertProfile,
    updateExpertConfig,
    deleteExpert,
    toggleStatus,
    cloneExpert,
    resetPage,
    formatUsageCount,
  }
})
