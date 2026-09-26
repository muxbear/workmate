import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type {
  KB,
  KBDoc,
  IndexConfig,
  SearchOutcome,
  SearchMode,
  ViewMode,
  CreateKBRequest,
  KbScope,
  KBShare,
  KBVisibility,
  PasteTextRequest,
  UrlImportRequest,
  DocSkip,
  KBGroup,
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

/** 单个文件的上传状态（对话框逐行展示） */
export interface UploadFileState {
  name: string
  status: 'pending' | 'uploading' | 'done' | 'skipped' | 'failed'
  percent: number
  message?: string
}

/** 一批上传的汇总（逐文件请求，部分成功是常态） */
export interface UploadSummary {
  created: number
  skipped: DocSkip[]
  failed: { name: string; message: string }[]
}

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

  // ─── 组织：分组 / 标签筛选 / 分页（迭代 6 T6.2）────────────────────────
  /** 本人的自定义分组 */
  const kbGroups = ref<KBGroup[]>([])
  /** 标签筛选（空 = 不筛） */
  const tagFilter = ref('')
  /** 分组筛选（空 = 不筛）；与搜索一样走服务端 */
  const groupFilter = ref('')
  /** 当前页与总数——**搜索与筛选都在服务端做**：此前是"拉 100 条再在前端过滤"，
   *  库超过 100 个时后面的根本搜不到 */
  const kbPage = ref(1)
  const kbPageSize = ref(24)
  const kbTotal = ref(0)

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
  /** SSE 通道（EventSource）；不可用时为 null，走轮询 */
  let indexStream: EventSource | null = null
  /** SSE 期间的兜底刷新定时器 */
  let indexFallbackTimer: ReturnType<typeof setInterval> | null = null

  // ─── 计算属性 ──────────────────────────────────────────────────────────

  /** 当前页的知识库（原样返回：搜索与标签筛选都已由服务端完成） */
  const filteredKbs = computed(() => kbs.value)

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

  /** 概览：全部可见知识库（服务端分页 + 搜索 + 标签筛选）+ 全局统计 */
  async function fetchKbs(page = kbPage.value) {
    loading.value = true
    error.value = null
    try {
      const result = await kbApi.fetchKBPage({
        scope: 'all',
        page,
        page_size: kbPageSize.value,
        search: searchQuery.value.trim() || undefined,
        tag: tagFilter.value || undefined,
        group_id: groupFilter.value || undefined,
      })
      kbs.value = result.items
      kbTotal.value = result.total
      kbPage.value = result.page
      statsPatch(await kbApi.fetchStats('all'))
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '加载知识库失败'
    } finally {
      loading.value = false
    }
  }

  /** 只改一页大小时回到第一页重新取 */
  async function setKbPage(page: number) {
    await fetchKbs(page)
  }

  async function setTagFilter(tag: string) {
    tagFilter.value = tag
    await fetchKbs(1)
  }

  async function setGroupFilter(groupId: string) {
    groupFilter.value = groupId
    await fetchKbs(1)
  }

  // ─── 组织动作（置顶 / 排序 / 复制 / 导出 / 分组）────────────────────────

  /** 列表里替换某一项（顺序与筛选由服务端决定，替换只用于就地刷新字段） */
  function patchKb(updated: KB) {
    kbs.value = kbs.value.map((k) => (k.id === updated.id ? { ...k, ...updated } : k))
    if (selectedKb.value?.id === updated.id) {
      selectedKb.value = { ...selectedKb.value, ...updated }
    }
  }

  /** 置顶 / 取消置顶；顺序会变，所以整页重取 */
  async function togglePin(kbId: string, pinned: boolean) {
    await kbApi.pinKnowledgeBase(kbId, pinned)
    await fetchKbs(kbPage.value)
  }

  /** 上移 / 下移一位（只在同一置顶分组内交换） */
  async function moveKb(kbId: string, direction: 'up' | 'down') {
    await kbApi.moveKnowledgeBase(kbId, direction)
    await fetchKbs(kbPage.value)
  }

  /** 复制（只复制定义与配置），成功后回到第一页让用户看到新库 */
  async function copyKb(kbId: string, name?: string): Promise<KB> {
    const created = await kbApi.copyKnowledgeBase(kbId, name)
    await fetchKbs(1)
    return created
  }

  /** 导出配置（前端落成 .json 文件） */
  async function exportKb(kbId: string, name: string) {
    await kbApi.downloadKnowledgeBaseConfig(kbId, name)
  }

  async function loadKbGroups() {
    kbGroups.value = await kbApi.fetchKbGroups()
  }

  async function createGroup(name: string): Promise<KBGroup> {
    const group = await kbApi.createKbGroup(name)
    kbGroups.value = [...kbGroups.value, group]
    return group
  }

  async function renameGroup(id: string, name: string): Promise<KBGroup> {
    const group = await kbApi.renameKbGroup(id, name)
    kbGroups.value = kbGroups.value.map((g) => (g.id === id ? group : g))
    return group
  }

  async function removeGroup(id: string) {
    await kbApi.deleteKbGroup(id)
    // 归属被解除：本地把这些库的 groupId 一并清掉（服务端已 SET NULL）
    kbs.value = kbs.value.map((k) => (k.groupId === id ? { ...k, groupId: null } : k))
    kbGroups.value = kbGroups.value.filter((g) => g.id !== id)
  }

  async function assignGroup(kbId: string, groupId: string | null) {
    patchKb(await kbApi.assignKbGroup(kbId, groupId))
    await loadKbGroups()   // 各组的计数变了
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

  /**
   * 上传文件（**逐文件请求**，带并发池）。
   *
   * 逐文件是为了给出每个文件自己的进度与成败：一次请求带 N 个文件时，失败只能
   * 整批算数，用户也不知道卡在哪一个上。并发限制在 2–3：既压住网络与内存，
   * 也降低撞限流的概率（429 会单独退避重试一次）。
   */
  async function uploadDocs(
    kbId: string,
    files: File[],
    config?: IndexConfig,
    hooks?: {
      onFileState?: (state: UploadFileState) => void
      concurrency?: number
    },
  ): Promise<UploadSummary> {
    const summary: UploadSummary = { created: 0, skipped: [], failed: [] }
    if (!files.length) return summary

    const concurrency = Math.min(Math.max(hooks?.concurrency ?? 2, 1), 3)
    const queue = [...files]

    const report = (state: UploadFileState) => hooks?.onFileState?.(state)

    const worker = async () => {
      for (;;) {
        const file = queue.shift()
        if (!file) return
        report({ name: file.name, status: 'uploading', percent: 0 })
        try {
          const result = await kbApi.uploadDocument(kbId, file, config, (percent) => {
            report({ name: file.name, status: 'uploading', percent })
          })
          if (result.created.length) {
            summary.created += result.created.length
            // 边传边出现：不必等整批结束，用户立刻看到这一篇已经进库
            if (selectedKb.value && selectedKb.value.id === kbId) {
              selectedKb.value = {
                ...selectedKb.value,
                documents: [...result.created, ...selectedKb.value.documents],
                docs: selectedKb.value.docs + result.created.length,
              }
            }
            report({ name: file.name, status: 'done', percent: 100 })
          } else {
            const skip = result.skipped[0]
            summary.skipped.push(...result.skipped)
            report({
              name: file.name,
              status: 'skipped',
              percent: 100,
              message: skip?.existingDocName
                ? `与《${skip.existingDocName}》内容相同`
                : '内容重复',
            })
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '上传失败'
          summary.failed.push({ name: file.name, message })
          report({ name: file.name, status: 'failed', percent: 0, message })
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, () => worker()),
    )
    return summary
  }

  /** 粘贴文本建文档（后端落成 `.md` 后走同一条流水线） */
  async function createTextDoc(kbId: string, payload: PasteTextRequest) {
    const result = await kbApi.createTextDocument(kbId, payload)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        documents: [...result.created, ...selectedKb.value.documents],
        docs: selectedKb.value.docs + result.created.length,
      }
    }
    return result
  }

  /** URL / 网页导入（抓取与 SSRF 防护都在后端） */
  async function importUrlDoc(kbId: string, payload: UrlImportRequest) {
    const result = await kbApi.importFromUrl(kbId, payload)
    if (selectedKb.value && selectedKb.value.id === kbId) {
      selectedKb.value = {
        ...selectedKb.value,
        documents: [...result.created, ...selectedKb.value.documents],
        docs: selectedKb.value.docs + result.created.length,
      }
    }
    return result
  }

  /** 批量删除/重试：逐项结果由调用方提示，这里只负责把本地状态对齐 */
  async function batchDocs(kbId: string, action: 'delete' | 'retry', docIds: string[]) {
    const result = await kbApi.batchDocumentOp(kbId, action, docIds)
    const okIds = new Set(result.items.filter((i) => i.ok).map((i) => i.docId))

    if (selectedKb.value && selectedKb.value.id === kbId && okIds.size) {
      const documents = action === 'delete'
        ? selectedKb.value.documents.filter((d) => !okIds.has(d.id))
        : selectedKb.value.documents.map((d) => {
            const item = result.items.find((i) => i.ok && i.docId === d.id)
            return item?.doc ?? d
          })
      selectedKb.value = {
        ...selectedKb.value,
        documents,
        // 删除会在后端重算计数，这里先按删除条数就地扣减，随后由刷新对齐
        docs: action === 'delete'
          ? Math.max(0, selectedKb.value.docs - okIds.size)
          : selectedKb.value.docs,
      }
    }
    if (action === 'delete' && selectedDoc.value && okIds.has(selectedDoc.value.id)) {
      selectedDoc.value = null
    }
    return result
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

  async function cancelDoc(kbId: string, docId: string) {
    const updatedDoc = await kbApi.cancelDocument(kbId, docId)
    applyDocPatch(updatedDoc)
    statsPatch(await kbApi.fetchStats('all'))
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
  ): Promise<SearchOutcome> {
    return kbApi.searchKnowledgeBase(kbId, query, mode)
  }

  // ─── 索引进度：SSE 为主、轮询兜底 ───────────────────────────────────────

  /** 把一次进度事件（或接口返回的文档）合并进当前知识库 */
  function applyDocPatch(patch: KBDoc) {
    if (!selectedKb.value) return
    selectedKb.value = {
      ...selectedKb.value,
      documents: selectedKb.value.documents.map((d) =>
        d.id === patch.id ? { ...d, ...patch } : d,
      ),
    }
    if (selectedDoc.value?.id === patch.id) {
      selectedDoc.value = { ...selectedDoc.value, ...patch }
    }
  }

  /** 兜底刷新：拉一次文档列表并同步计数（SSE 丢事件或断开时使用） */
  async function refreshActiveDocuments() {
    const kb = selectedKb.value
    if (!kb) return
    try {
      const docData = await kbApi.fetchDocuments(kb.id, { page_size: 100 })
      if (selectedKb.value && selectedKb.value.id === kb.id) {
        selectedKb.value = { ...selectedKb.value, documents: docData.items }
      }
      statsPatch(await kbApi.fetchStats('all'))
    } catch {
      // 静默忽略：下一次事件或轮询会纠正
    }
  }

  function isTerminal(status: KBDoc['status']) {
    return status === 'indexed' || status === 'failed' || status === 'canceled'
  }

  /**
   * 订阅索引进度。
   *
   * 优先用 SSE（索引完成 1 秒内可见、不再整表轮询）；拿不到 token 或环境不支持
   * EventSource 时退回 5 秒轮询。SSE 期间仍保留一个 30 秒的兜底轮询——事件是
   * 可丢弃的状态快照，兜底刷新能纠正任何丢失。
   */
  function startIndexPolling() {
    stopIndexPolling()
    const kb = selectedKb.value
    if (!kb) return

    const url = kbApi.buildIndexingStreamUrl(kb.id)
    if (url && typeof EventSource !== 'undefined') {
      try {
        indexStream = new EventSource(url)
        indexStream.onmessage = (event: MessageEvent<string>) => {
          try {
            const payload = JSON.parse(event.data) as {
              doc_id: string
              status: KBDoc['status']
              progress: number
              chunks_count: number
              entities_count?: number
              relations_count?: number
              error_message: string | null
              graph_error?: string | null
              stages?: KBDoc['stages']
            }
            const current = selectedKb.value?.documents.find(
              (d) => d.id === payload.doc_id,
            )
            // 只更新本地已有的行：事件里带的是增量字段，凭空造对象会产生缺字段的文档
            if (current) {
              applyDocPatch({
                ...current,
                status: payload.status,
                progress: Math.max(payload.progress ?? 0, 0),
                chunks: payload.chunks_count ?? current.chunks,
                entities: payload.entities_count ?? current.entities,
                relations: payload.relations_count ?? current.relations,
                errorMessage: payload.error_message,
                graphError: payload.graph_error ?? current.graphError,
                stages: payload.stages?.length ? payload.stages : current.stages,
              })
            }
            if (isTerminal(payload.status)) {
              void refreshActiveDocuments()
            }
          } catch {
            // 事件格式异常时忽略，兜底轮询会纠正
          }
        }
        indexStream.onerror = () => {
          // EventSource 会自动重连；连续失败由兜底轮询兜住
        }
        indexFallbackTimer = setInterval(refreshActiveDocuments, 30000)
        return
      } catch {
        indexStream = null
      }
    }

    // 回退路径：5 秒轮询（仅在存在未完成文档时才真正拉取）
    indexPollTimer = setInterval(async () => {
      const current = selectedKb.value
      if (!current) return
      if (!current.documents.some((d) => !isTerminal(d.status))) return
      await refreshActiveDocuments()
    }, 5000)
  }

  function stopIndexPolling() {
    if (indexPollTimer) {
      clearInterval(indexPollTimer)
      indexPollTimer = null
    }
    if (indexFallbackTimer) {
      clearInterval(indexFallbackTimer)
      indexFallbackTimer = null
    }
    if (indexStream) {
      indexStream.close()
      indexStream = null
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
    kbGroups,
    tagFilter,
    groupFilter,
    kbPage,
    kbPageSize,
    kbTotal,
    setKbPage,
    setTagFilter,
    setGroupFilter,
    togglePin,
    moveKb,
    copyKb,
    exportKb,
    loadKbGroups,
    createGroup,
    renameGroup,
    removeGroup,
    assignGroup,
    uploadDocs,
    createTextDoc,
    importUrlDoc,
    batchDocs,
    deleteDoc,
    retryDoc,
    cancelDoc,
    reindexKb,
    searchKb,
    startIndexPolling,
    stopIndexPolling,
  }
})
