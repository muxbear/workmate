import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type {
  KB,
  KBDoc,
  IndexConfig,
  SearchResult,
  SearchMode,
  ViewMode,
  CreateKBRequest,
  KbScope,
  KBShare,
  KBVisibility,
} from '@/types/knowledgeBase'
import { KB_GROUP_PREVIEW_LIMIT } from '@/types/knowledgeBase'
import * as kbApi from '@/services/knowledgeBaseApi'
import type { KBListScope } from '@/services/knowledgeBaseApi'

/** 左栏分组（「知识库概览」不是分组，单独渲染） */
export interface KbGroupDef {
  id: Exclude<KbScope, 'overview'>
  label: string
  /** 后端列表 scope */
  apiScope: KBListScope
}

export const KB_GROUPS: KbGroupDef[] = [
  { id: 'public', label: '公共知识库', apiScope: 'public' },
  { id: 'personal', label: '个人知识库', apiScope: 'personal' },
  { id: 'sharedByMe', label: '我的共享知识', apiScope: 'personal' },
  { id: 'sharedWithMe', label: '共享给我的', apiScope: 'shared_with_me' },
]

/** 一个分组的列表 + 分页状态 */
interface GroupState {
  items: KB[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  loaded: boolean
}

function emptyGroup(pageSize = 12): GroupState {
  return { items: [], total: 0, page: 1, pageSize, loading: false, loaded: false }
}

export const useKnowledgeBaseStore = defineStore('knowledgeBase', () => {
  // ─── 列表状态 ──────────────────────────────────────────────────────────
  const kbs = ref<KB[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 当前选中知识库 / 文档
  const selectedKb = ref<KB | null>(null)
  const selectedDoc = ref<KBDoc | null>(null)

  // 视图模式
  const viewMode = ref<ViewMode>('grid')

  // 搜索（本地过滤用）
  const searchQuery = ref('')

  // 统计信息
  const stats = ref({
    totalKbs: 0,
    totalDocs: 0,
    totalChunks: 0,
    totalEntities: 0,
    indexing: 0,
  })

  // ─── 左栏导航状态 ──────────────────────────────────────────────────────

  /** 当前激活的栏目：overview 概览，其余为分组 id */
  const activeNav = ref<KbScope>('overview')
  /** 分组折叠状态（默认全展开） */
  const groupExpanded = ref<Record<string, boolean>>({
    public: true,
    personal: true,
    sharedByMe: true,
    sharedWithMe: true,
  })

  /** 每个分组的列表状态 */
  const groups = ref<Record<string, GroupState>>({
    public: emptyGroup(),
    personal: emptyGroup(),
    sharedByMe: emptyGroup(),
    sharedWithMe: emptyGroup(),
  })

  /** 「我的共享知识」：我分享出去的记录（按 kb_id 归组） */
  const sharesByMe = ref<Record<string, KBShare[]>>({})
  /** 「共享给我的」：收到的邀请（含待接受） */
  const invitations = ref<KBShare[]>([])

  /** 索引进度轮询定时器 */
  let indexPollTimer: ReturnType<typeof setInterval> | null = null

  // ─── 计算属性 ──────────────────────────────────────────────────────────

  const filteredKbs = computed(() => {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return kbs.value
    return kbs.value.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        k.description.toLowerCase().includes(q) ||
        k.tags.some((t) => t.toLowerCase().includes(q)),
    )
  })

  /** 左栏子项：每个分组只预览前 N 条 */
  function groupPreview(groupId: string): KB[] {
    const g = groups.value[groupId]
    if (!g) return []
    return g.items.slice(0, KB_GROUP_PREVIEW_LIMIT)
  }

  /** 分组是否还有更多（用于「查看更多」的提示） */
  function groupHasMore(groupId: string): boolean {
    const g = groups.value[groupId]
    return !!g && g.total > KB_GROUP_PREVIEW_LIMIT
  }

  /** 待接受的邀请数量（左栏角标） */
  const pendingInvitationCount = computed(
    () => invitations.value.filter((i) => i.status === 'pending').length,
  )

  /** 「共享给我的」分组子项：已接受的知识库 */
  function acceptedInvitations(): KBShare[] {
    return invitations.value.filter((i) => i.status === 'accepted')
  }

  function ownedSharesFor(kbId: string): KBShare[] {
    return sharesByMe.value[kbId] || []
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  function statsPatch(s: kbApi.KBStatsResponse) {
    stats.value = {
      totalKbs: s.totalKbs,
      totalDocs: s.totalDocs,
      totalChunks: s.totalChunks,
      totalEntities: s.totalEntities,
      indexing: s.indexing,
    }
  }

  /** 概览：全部可见知识库 + 全局统计 */
  async function fetchKbs() {
    loading.value = true
    error.value = null
    try {
      const page = await kbApi.fetchKBPage({ scope: 'all', page: 1, page_size: 100 })
      kbs.value = page.items
      statsPatch(await kbApi.fetchStats('all'))
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '加载知识库失败'
    } finally {
      loading.value = false
    }
  }

  /**
   * 加载某个分组的（分页）列表。
   *
   * 「我的共享知识」在客户端按分享记录过滤——后端 personal scope 返回的是
   * 我创建的库，其中只有被我分享出去的那些才属于该栏目。
   */
  async function loadGroup(groupId: KbScope, page = 1) {
    const def = KB_GROUPS.find((g) => g.id === groupId)
    const state = groups.value[groupId as string]
    if (!def || !state) return

    state.loading = true
    try {
      if (groupId === 'sharedWithMe') {
        // 邀请记录单独拉取：待接受项要渲染「接受 / 拒绝」，已接受项即下方的可见列表
        const res = await kbApi.fetchShareInvitations()
        invitations.value = res.items
        // 后端 shared_with_me 已只返回「已接受」的库，无需再按邀请记录二次过滤
        const list = await kbApi.fetchKBPage({
          scope: 'shared_with_me',
          page,
          page_size: state.pageSize,
        })
        state.items = list.items
        state.total = list.total
      } else if (groupId === 'sharedByMe') {
        await loadSharesByMe()
        const mine = await kbApi.fetchKBPage({
          scope: 'personal',
          page,
          page_size: 100,
        })
        const sharedIds = Object.keys(sharesByMe.value)
        const items = mine.items.filter((k) => sharedIds.includes(k.id))
        state.items = items
        state.total = items.length
      } else {
        const list = await kbApi.fetchKBPage({
          scope: def.apiScope,
          page,
          page_size: state.pageSize,
        })
        state.items = list.items
        state.total = list.total
      }
      state.page = page
      state.loaded = true
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '加载列表失败'
    } finally {
      state.loading = false
    }
  }

  /** 加载所有分组（页面首次进入时并行拉取左栏子项） */
  async function loadAllGroups() {
    await Promise.all(
      KB_GROUPS.map((g) => loadGroup(g.id as KbScope, 1)),
    )
  }

  /** 汇总「我分享出去的」：一次请求拿回跨库的全部分享记录，按 kb_id 归组 */
  async function loadSharesByMe() {
    const res = await kbApi.fetchSharesByMe()
    const map: Record<string, KBShare[]> = {}
    for (const share of res.items) {
      ;(map[share.kbId] ||= []).push(share)
    }
    sharesByMe.value = map
  }

  function setActiveNav(nav: KbScope) {
    activeNav.value = nav
    if (nav !== 'overview' && !groups.value[nav]?.loaded) {
      void loadGroup(nav, 1)
    }
  }

  function toggleGroup(groupId: string) {
    groupExpanded.value[groupId] = !groupExpanded.value[groupId]
  }

  async function selectKb(id: string) {
    loading.value = true
    try {
      const kb = await kbApi.fetchKnowledgeBase(id)
      if (kb) {
        const docData = await kbApi.fetchDocuments(id, { page_size: 100 })
        const graphData = await kbApi.fetchGraphData(id)

        selectedKb.value = {
          ...kb,
          documents: docData.items,
          entitiesData: graphData.entities.map((e) => ({
            ...e,
            x: 0,
            y: 0,
          })),
          relationsData: graphData.relations,
        }
        selectedDoc.value = null
        startIndexPolling()
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '加载知识库详情失败'
      error.value = msg
    } finally {
      loading.value = false
    }
  }

  function clearSelection() {
    stopIndexPolling()
    selectedKb.value = null
    selectedDoc.value = null
  }

  async function createKb(data: CreateKBRequest) {
    loading.value = true
    try {
      const kb = await kbApi.createKnowledgeBase(data)
      kbs.value.unshift(kb)
      // 新创建的知识库设置空数组避免组件访问 .slice/.filter 时崩溃
      selectedKb.value = { ...kb, documents: [], entitiesData: [], relationsData: [] }
      selectedDoc.value = null
      statsPatch(await kbApi.fetchStats('all'))
      await loadGroup('personal', 1)
      return kb
    } finally {
      loading.value = false
    }
  }

  async function updateKb(id: string, patch: Partial<KB>) {
    const updated = await kbApi.updateKnowledgeBase(id, patch)
    const idx = kbs.value.findIndex((k) => k.id === id)
    if (idx !== -1) kbs.value[idx] = { ...kbs.value[idx], ...updated }
    if (selectedKb.value?.id === id) {
      selectedKb.value = { ...selectedKb.value, ...updated }
    }
  }

  async function deleteKb(id: string) {
    await kbApi.deleteKnowledgeBase(id)
    kbs.value = kbs.value.filter((k) => k.id !== id)
    if (selectedKb.value?.id === id) clearSelection()
    statsPatch(await kbApi.fetchStats('all'))
    await loadAllGroups()
  }

  // ─── 分享 ──────────────────────────────────────────────────────────────

  /** 发布 / 取消发布公共知识库 */
  async function setVisibility(kbId: string, visibility: KBVisibility) {
    const updated = await kbApi.updateKbVisibility(kbId, visibility)
    if (selectedKb.value?.id === kbId) {
      selectedKb.value = { ...selectedKb.value, ...updated }
    }
    const idx = kbs.value.findIndex((k) => k.id === kbId)
    if (idx !== -1) kbs.value[idx] = { ...kbs.value[idx], ...updated }
    await Promise.all([loadGroup('public', 1), loadGroup('personal', 1)])
    return updated
  }

  /**
   * 邀请用户浏览知识库。
   *
   * 不在此处手写 sharesByMe：`loadGroup('sharedByMe')` 会从服务端重拉，
   * 本地先写再被覆盖只会造成闪烁与两份真相。
   */
  async function inviteShares(kbId: string, userIds: string[]) {
    const res = await kbApi.createKbShares(kbId, userIds)
    await loadGroup('sharedByMe', 1)
    return res
  }

  /** 删除单个被分享用户 */
  async function removeShare(kbId: string, shareId: string) {
    await kbApi.deleteKbShare(kbId, shareId)
    await loadGroup('sharedByMe', 1)
  }

  /** 取消该知识库的全部分享 */
  async function cancelShares(kbId: string) {
    await kbApi.cancelKbShares(kbId)
    await loadGroup('sharedByMe', 1)
  }

  /** 接受 / 拒绝邀请（被分享方） */
  async function respondInvitation(shareId: string, accept: boolean) {
    if (accept) {
      await kbApi.acceptKbShare(shareId)
    } else {
      await kbApi.rejectKbShare(shareId)
    }
    await loadGroup('sharedWithMe', 1)
  }

  // ─── 文档 ──────────────────────────────────────────────────────────────

  async function uploadDocs(kbId: string, files: File[], config?: IndexConfig) {
    if (!files.length) return
    const newDocs = await kbApi.uploadDocuments(kbId, files, config)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        documents: [...newDocs, ...selectedKb.value.documents],
        docs: selectedKb.value.docs + newDocs.length,
      }
    }
  }

  async function deleteDoc(kbId: string, docId: string) {
    await kbApi.deleteDocument(kbId, docId)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        documents: selectedKb.value.documents.filter((d) => d.id !== docId),
      }
    }
    if (selectedDoc.value?.id === docId) selectedDoc.value = null
  }

  async function retryDoc(kbId: string, docId: string) {
    const updatedDoc = await kbApi.retryDocument(kbId, docId)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        documents: selectedKb.value.documents.map((d) =>
          d.id === docId ? updatedDoc : d,
        ),
      }
    }
  }

  async function reindexKb(kbId: string, config: IndexConfig) {
    const result = await kbApi.reindexKnowledgeBase(kbId, config)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        status: 'indexing',
        config,
      }
    }
    statsPatch(await kbApi.fetchStats('all'))
    return result
  }

  async function searchKb(
    kbId: string,
    query: string,
    mode: SearchMode,
  ): Promise<SearchResult[]> {
    return kbApi.searchKnowledgeBase(kbId, query, mode)
  }

  // ─── 索引进度轮询 ──────────────────────────────────────────────────────

  function startIndexPolling() {
    stopIndexPolling()
    indexPollTimer = setInterval(async () => {
      if (!selectedKb.value) return
      const kbId = selectedKb.value.id

      // 只对有索引中文档的知识库做轮询
      const hasActive = selectedKb.value.documents.some(
        (d) => d.status !== 'indexed' && d.status !== 'failed',
      )
      if (!hasActive) return

      try {
        // 重新拉取文档列表
        const docData = await kbApi.fetchDocuments(kbId, { page_size: 100 })
        if (selectedKb.value) {
          selectedKb.value = {
            ...selectedKb.value,
            documents: docData.items,
          }
        }
      } catch {
        // 轮询失败静默忽略
      }
    }, 5000)
  }

  function stopIndexPolling() {
    if (indexPollTimer) {
      clearInterval(indexPollTimer)
      indexPollTimer = null
    }
  }

  return {
    // state
    kbs,
    loading,
    error,
    selectedKb,
    selectedDoc,
    viewMode,
    searchQuery,
    stats,
    activeNav,
    groupExpanded,
    groups,
    sharesByMe,
    invitations,
    // getters
    filteredKbs,
    groupPreview,
    groupHasMore,
    pendingInvitationCount,
    acceptedInvitations,
    ownedSharesFor,
    // actions
    fetchKbs,
    loadGroup,
    loadAllGroups,
    loadSharesByMe,
    setActiveNav,
    toggleGroup,
    selectKb,
    clearSelection,
    createKb,
    updateKb,
    deleteKb,
    setVisibility,
    inviteShares,
    removeShare,
    cancelShares,
    respondInvitation,
    uploadDocs,
    deleteDoc,
    retryDoc,
    reindexKb,
    searchKb,
    startIndexPolling,
    stopIndexPolling,
  }
})
