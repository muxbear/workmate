import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  IpcResult,
  KnowledgeBaseSummary,
  KnowledgeDocumentMeta,
  KnowledgeGraphView,
  KnowledgeIndexState,
  KnowledgeKind,
  KnowledgeAskEvent,
  KnowledgeOverrides,
  KnowledgeQaCitation,
  KnowledgeSearchResult,
  KnowledgeShare,
  KnowledgeStats
} from '../../../preload/index.d'

/**
 * IPC 调用被 reject 时的兜底文案。
 * 典型场景：主进程还是旧实例、尚未注册该通道（渲染层热更新后常见），
 * 此时 `ipcRenderer.invoke` 会 reject 而不是返回 `{ success: false }`。
 */
const IPC_FALLBACK = '与主进程通信失败，请重启应用后重试'

/**
 * 统一收敛知识库 IPC 调用。
 *
 * `window.api.*` 内部是 `ipcRenderer.invoke`，在「无对应 handler」等情况下会 reject；
 * 直接 await 会让按钮点击**静默无反应**。这里统一转成失败结果，交给调用方提示。
 */
async function call<T>(run: () => Promise<IpcResult<T>>, fallback: string): Promise<IpcResult<T>> {
  try {
    return await run()
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : ''
    return { success: false, error: detail ? `${fallback}（${detail}）` : fallback }
  }
}

/**
 * 知识库 store（渲染层唯一数据源）
 *
 * - 数据来自主进程（knowledge:* IPC）：渲染层只持 ID 与库内相对路径；
 * - 文件树不在这里构建：页面用 `relPath` 调用 `mergeUploads()` 还原层级（复用既有纯函数）；
 * - 索引进度走 `knowledge:import-progress` 事件做局部 patch，终态再全量刷新；
 * - 检索入口两条（页面问答 / 会话 kb_search）在主进程共用同一实现。
 */
export const useKnowledgeStore = defineStore('knowledge', () => {
  const bases = ref<KnowledgeBaseSummary[]>([])
  /** kbId → 文档元信息（按 relPath 排序） */
  const documentsByKb = ref<Record<string, KnowledgeDocumentMeta[]>>({})
  const stats = ref<KnowledgeStats | null>(null)
  const loading = ref(false)
  const lastError = ref('')

  /** 当前选中的知识库 ID（页面切换时写回，用于「重进页面恢复」） */
  const selectedKbId = ref('')

  const selectedBase = computed<KnowledgeBaseSummary | null>(() => {
    if (!bases.value.length) return null
    return bases.value.find((item) => item.id === selectedKbId.value) ?? bases.value[0]
  })

  function baseById(id: string): KnowledgeBaseSummary | null {
    return bases.value.find((item) => item.id === id) ?? null
  }

  function documentsOf(kbId: string): KnowledgeDocumentMeta[] {
    return documentsByKb.value[kbId] ?? []
  }

  async function loadBases(kind?: KnowledgeKind): Promise<boolean> {
    loading.value = true
    const result = await call(
      () => window.api.listKnowledgeBases(kind ? { kind } : undefined),
      IPC_FALLBACK
    )
    loading.value = false
    if (!result.success) {
      lastError.value = result.error ?? '读取知识库失败'
      return false
    }
    bases.value = result.data ?? []
    if (!bases.value.some((item) => item.id === selectedKbId.value)) {
      selectedKbId.value = bases.value[0]?.id ?? ''
    }
    lastError.value = ''
    return true
  }

  async function loadDocuments(kbId: string): Promise<boolean> {
    if (!kbId) return false
    const result = await call(() => window.api.listKnowledgeDocuments(kbId), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '读取文件列表失败'
      return false
    }
    documentsByKb.value = { ...documentsByKb.value, [kbId]: result.data ?? [] }
    lastError.value = ''
    return true
  }

  async function loadStats(): Promise<boolean> {
    const result = await call(() => window.api.getKnowledgeStats(), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '读取概览失败'
      return false
    }
    stats.value = result.data ?? null
    return true
  }

  /** 选中知识库：切换后按需拉取文件列表 */
  async function selectBase(id: string): Promise<void> {
    if (selectedKbId.value !== id) {
      // 换库：问答历史随之失效（不同库的上下文不能串）
      qaRounds.value = []
      askState.value = null
    }
    selectedKbId.value = id
    await loadDocuments(id)
  }

  async function createBase(input: {
    name: string
    description?: string
    kind?: KnowledgeKind
  }): Promise<KnowledgeBaseSummary | null> {
    const result = await call(() => window.api.createKnowledgeBase(input), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '创建知识库失败'
      return null
    }
    await loadBases()
    if (result.data) await selectBase(result.data.id)
    return result.data ?? null
  }

  async function updateBase(
    id: string,
    patch: { name?: string; description?: string }
  ): Promise<boolean> {
    const result = await call(() => window.api.updateKnowledgeBase(id, patch), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '保存知识库失败'
      return false
    }
    await loadBases()
    return true
  }

  async function removeBase(id: string): Promise<boolean> {
    const result = await call(() => window.api.deleteKnowledgeBase(id), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '删除知识库失败'
      return false
    }
    const next = { ...documentsByKb.value }
    delete next[id]
    documentsByKb.value = next
    await loadBases()
    return true
  }

  /** 拖拽排序：按主进程返回的顺序重建列表（失败时重新拉取，避免本地顺序与库不一致） */
  async function reorderBases(kind: KnowledgeKind, orderedIds: string[]): Promise<boolean> {
    const result = await call(
      () => window.api.reorderKnowledgeBases(kind, orderedIds),
      IPC_FALLBACK
    )
    if (!result.success) {
      const message = result.error ?? '保存排序失败'
      // 重新拉取会清空 lastError，这里在拉取后恢复，保证调用方能弹出真实原因
      await loadBases()
      lastError.value = message
      return false
    }
    bases.value = result.data ?? bases.value
    lastError.value = ''
    return true
  }

  /** 置顶 / 取消置顶：排序规则在主进程，直接采用返回的全量列表 */
  async function setPinned(id: string, pinned: boolean): Promise<boolean> {
    const result = await call(() => window.api.setKnowledgeBasePinned(id, pinned), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '置顶设置失败'
      return false
    }
    bases.value = result.data ?? bases.value
    lastError.value = ''
    return true
  }

  async function importDocuments(
    kbId: string,
    items: Array<{ srcPath: string; relPath: string }>,
    options: { indexState?: KnowledgeIndexState; config?: KnowledgeOverrides | null } = {}
  ): Promise<{ accepted: number; skipped: number; failed: number; message: string } | null> {
    const indexState = options.indexState ?? 'none'
    const result = await call(
      () =>
        window.api.importKnowledgeDocuments(
          kbId,
          items,
          indexState,
          indexState === 'custom' ? (options.config ?? null) : null
        ),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '上传失败'
      return null
    }
    const data = result.data
    await loadDocuments(kbId)
    await loadBases()
    const skipped = data?.skipped ?? []
    const failed = data?.failed ?? []
    const parts = [`已上传 ${data?.accepted.length ?? 0} 个文件`]
    if (indexState !== 'none' && data?.accepted.length) {
      parts.push('已开始建立索引')
    }
    if (skipped.length) parts.push(`跳过 ${skipped.length} 个（${skipped[0].reason}）`)
    if (failed.length) parts.push(`失败 ${failed.length} 个（${failed[0].reason}）`)
    lastError.value = ''
    return {
      accepted: data?.accepted.length ?? 0,
      skipped: skipped.length,
      failed: failed.length,
      message: parts.join('，')
    }
  }

  /** 重建索引：省略 relPaths = 整库（含文件夹前缀） */
  async function reindex(kbId: string, relPaths?: string[]): Promise<number> {
    const result = await call(() => window.api.reindexKnowledge(kbId, relPaths), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '重建索引失败'
      return 0
    }
    await loadDocuments(kbId)
    return result.data?.queued ?? 0
  }

  /** 重试失败文档 */
  async function retryDocument(kbId: string, relPath: string): Promise<boolean> {
    const result = await call(
      () => window.api.retryKnowledgeDocument(kbId, relPath),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '重试失败'
      return false
    }
    await loadDocuments(kbId)
    return true
  }

  /** 重抽图谱（只跑抽取，用已存切片）；省略 relPaths = 整库 */
  async function reextractGraph(kbId: string, relPaths?: string[]): Promise<number> {
    const result = await call(
      () => window.api.reextractKnowledgeGraph(kbId, relPaths),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '重抽图谱失败'
      return 0
    }
    await loadDocuments(kbId)
    return result.data?.queued ?? 0
  }

  /** 备份索引库（另存为对话框在主进程；取消返回 null） */
  async function backupIndex(): Promise<{ canceled: boolean; path?: string; size?: string } | null> {
    const result = await call(() => window.api.backupKnowledgeIndex(), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '备份失败'
      return null
    }
    if (result.data?.canceled) return { canceled: true }
    const size = result.data?.sizeBytes ?? 0
    return {
      canceled: false,
      path: result.data?.path,
      size: size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`
    }
  }

  /** 重建社区摘要（GraphRAG 全局检索侧）：返回生成的社区数 */
  async function rebuildCommunities(kbId: string): Promise<number> {
    const result = await call(() => window.api.rebuildKnowledgeCommunities(kbId), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '重建社区摘要失败'
      return 0
    }
    return result.data?.communities ?? 0
  }

  /** 取消索引任务：省略 relPaths = 整库 */
  async function cancelIndex(kbId: string, relPaths?: string[]): Promise<number> {
    const result = await call(() => window.api.cancelKnowledgeIndex(kbId, relPaths), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '取消失败'
      return 0
    }
    await loadDocuments(kbId)
    return result.data?.canceled ?? 0
  }

  /** 检索（P0 起可用；命中自带引用与降级标记；debug 供检索调试面板） */
  async function search(
    kbId: string,
    query: string,
    options?: { topK?: number; mode?: 'hybrid' | 'vector' | 'bm25'; debug?: boolean }
  ): Promise<KnowledgeSearchResult | null> {
    const result = await call(
      () => window.api.searchKnowledge(kbId, query, options),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '检索失败'
      return null
    }
    return result.data ?? null
  }

  /** 图谱可视化数据（只读；节点/边由主进程跨文档聚合折叠） */
  async function graphView(
    kbId: string,
    options?: { limit?: number }
  ): Promise<KnowledgeGraphView | null> {
    const result = await call(() => window.api.getKnowledgeGraph(kbId, options), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '读取图谱失败'
      return null
    }
    return result.data ?? null
  }

  // ── 知识库问答（2-Step RAG，流式）──

  /** 最近一次索引进度里的非致命告警（图谱抽取失败等）；页面消费后清空 */
  const indexWarning = ref('')

  /** 已完成的问答轮次（多轮上下文 + 面板列表；按库切换时清空） */
  const qaRounds = ref<Array<{ question: string; answer: string }>>([])

  /** 最多带入模型的历史轮数（与主进程闸门一致） */
  const QA_HISTORY_TURNS = 3

  /** 当前问答状态（null = 从未提问） */
  const askState = ref<{
    kbId: string
    requestId: string
    question: string
    answer: string
    citations: KnowledgeQaCitation[]
    streaming: boolean
    canceled: boolean
    noRelevantResult: boolean
    /** 越界引用编号（非空时 UI 提示核对） */
    invalidCitations: number[]
    error: string
  } | null>(null)

  /** 发起提问（同一窗口先取消上一次）；返回 false 表示未发起（错误已写进 state） */
  async function askQuestion(
    kbId: string,
    question: string,
    modelName?: string
  ): Promise<boolean> {
    const text = question.trim()
    if (!text) return false
    // 必须**显式拷成普通对象**：qaRounds 里的元素是 Vue 响应式代理，
    // 直接丢给 ipcRenderer.invoke 会被 structuredClone 拒绝（"An object could not be cloned"），
    // 表现为多轮提问的第二问直接失败
    const history = qaRounds.value
      .slice(-QA_HISTORY_TURNS)
      .map((round) => ({ question: String(round.question), answer: String(round.answer) }))
    const result = await call(
      () => window.api.askKnowledge(kbId, text, modelName, history),
      IPC_FALLBACK
    )
    if (!result.success) {
      askState.value = {
        kbId,
        requestId: '',
        question: text,
        answer: '',
        citations: [],
        streaming: false,
        canceled: false,
        noRelevantResult: false,
        invalidCitations: [],
        error: result.error ?? '提问失败'
      }
      return false
    }
    askState.value = {
      kbId,
      requestId: result.data?.requestId ?? '',
      question: text,
      answer: '',
      citations: [],
      streaming: true,
      canceled: false,
      noRelevantResult: false,
      invalidCitations: [],
      error: ''
    }
    return true
  }

  /** 取消当前问答（流式停止，保留已产出内容） */
  async function cancelAsk(): Promise<void> {
    await call(() => window.api.cancelKnowledgeAsk(), IPC_FALLBACK)
  }

  function clearAsk(): void {
    askState.value = null
  }

  /** 清空多轮历史（「新对话」按钮 / 切换知识库时） */
  function clearQaHistory(): void {
    qaRounds.value = []
    askState.value = null
  }

  /** 订阅问答事件（幂等；返回退订函数）。requestId 不匹配的事件直接丢弃。 */
  function subscribeAsk(): () => void {
    const match = (payload: KnowledgeAskEvent): boolean => {
      const state = askState.value
      if (!state || state.kbId !== payload.kbId) return false
      if (payload.requestId && state.requestId && payload.requestId !== state.requestId) return false
      return true
    }
    const offs = [
      window.api.onKnowledgeAskCitation((payload) => {
        if (!match(payload)) return
        askState.value = { ...askState.value!, citations: payload.citations ?? [] }
      }),
      window.api.onKnowledgeAskChunk((payload) => {
        if (!match(payload) || !payload.text) return
        askState.value = { ...askState.value!, answer: askState.value!.answer + payload.text }
      }),
      window.api.onKnowledgeAskDone((payload) => {
        if (!match(payload)) return
        const finished = {
          ...askState.value!,
          streaming: false,
          canceled: payload.canceled === true,
          noRelevantResult: payload.noRelevantResult === true,
          invalidCitations: payload.invalidCitations ?? []
        }
        askState.value = finished
        // 有实际答案才进历史（「未找到」不进：它对后续追问没有上下文价值）
        if (finished.answer.trim() && !finished.error) {
          qaRounds.value = [
            ...qaRounds.value,
            { question: finished.question, answer: finished.answer }
          ].slice(-10)
        }
      }),
      window.api.onKnowledgeAskError((payload) => {
        if (!match(payload)) return
        askState.value = {
          ...askState.value!,
          streaming: false,
          error: payload.error ?? '问答失败'
        }
      })
    ]
    return () => {
      for (const off of offs) off()
    }
  }

  /**
   * 订阅索引进度事件（幂等；返回退订函数）。
   * 进度事件只做局部 patch，避免每个阶段都全量拉文档列表。
   */
  function subscribeIndexProgress(): () => void {
    return window.api.onKnowledgeIndexProgress((progress) => {
      const list = documentsByKb.value[progress.kbId]
      if (!list) return
      const index = list.findIndex((doc) => doc.id === progress.docId)
      if (index < 0) return
      const doc = list[index]
      list[index] = {
        ...doc,
        status: progress.status,
        stage: progress.stage,
        progress: progress.progress,
        chunksCount: progress.chunks || doc.chunksCount,
        entitiesCount: progress.entities || doc.entitiesCount,
        relationsCount: progress.relations || doc.relationsCount,
        errorMessage: progress.error ?? (progress.status === 'failed' ? doc.errorMessage : null)
      }
      if (progress.warning) indexWarning.value = progress.warning
      if (progress.status === 'indexed' || progress.status === 'failed') {
        // 终态：拉一次最新列表与库汇总（计数/排序可能变化）
        void loadDocuments(progress.kbId)
        void loadBases()
      }
    })
  }

  async function renameDocument(
    kbId: string,
    relPath: string,
    newName: string
  ): Promise<{ relPath: string } | null> {
    const result = await call(
      () => window.api.renameKnowledgeDocument(kbId, relPath, newName),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '重命名失败'
      return null
    }
    await loadDocuments(kbId)
    return result.data ?? null
  }

  async function removeDocument(kbId: string, relPath: string): Promise<boolean> {
    const result = await call(() => window.api.removeKnowledgeDocument(kbId, relPath), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '删除失败'
      return false
    }
    await loadDocuments(kbId)
    await loadBases()
    return true
  }

  /** 打开知识库所在目录（系统文件管理器） */
  async function openBaseDir(kbId: string): Promise<boolean> {
    const result = await call(() => window.api.openKnowledgeBaseDir(kbId), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '打开文件夹失败'
      return false
    }
    return true
  }

  /** 打开文件所在目录（并在资源管理器中选中该文件） */
  async function openFileDir(kbId: string, relPath: string): Promise<boolean> {
    const result = await call(() => window.api.openKnowledgeFileDir(kbId, relPath), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '打开文件夹失败'
      return false
    }
    return true
  }

  async function readFile(
    kbId: string,
    relPath: string,
    as: 'text' | 'bytes',
    cursor?: number
  ): Promise<{
    content?: string
    truncated?: boolean
    cursor?: number
    totalChars?: number
    bytes?: Uint8Array
    ext: string
    name: string
  } | null> {
    const result = await call(
      () => window.api.readKnowledgeFile(kbId, relPath, as, cursor),
      IPC_FALLBACK
    )
    if (!result.success) {
      lastError.value = result.error ?? '读取文件失败'
      return null
    }
    return result.data ?? null
  }

  async function createShare(input: {
    targetKind: 'library' | 'folder' | 'file'
    targetId: string
    targetName: string
    expiresInDays?: number
  }): Promise<KnowledgeShare | null> {
    const result = await call(() => window.api.createKnowledgeShare(input), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '创建共享失败'
      return null
    }
    return result.data ?? null
  }

  async function listShares(): Promise<KnowledgeShare[]> {
    const result = await call(() => window.api.listKnowledgeShares(), IPC_FALLBACK)
    if (!result.success) return []
    return result.data ?? []
  }

  async function revokeShare(token: string): Promise<boolean> {
    const result = await call(() => window.api.revokeKnowledgeShare(token), IPC_FALLBACK)
    if (!result.success) {
      lastError.value = result.error ?? '取消共享失败'
      return false
    }
    return true
  }

  /** 退出登录时清空（避免上一个用户的列表短暂可见） */
  function reset(): void {
    bases.value = []
    documentsByKb.value = {}
    stats.value = null
    selectedKbId.value = ''
    lastError.value = ''
  }

  return {
    bases,
    documentsByKb,
    stats,
    loading,
    lastError,
    selectedKbId,
    selectedBase,
    baseById,
    documentsOf,
    loadBases,
    loadDocuments,
    loadStats,
    selectBase,
    createBase,
    updateBase,
    removeBase,
    reorderBases,
    setPinned,
    importDocuments,
    reindex,
    reextractGraph,
    rebuildCommunities,
    backupIndex,
    retryDocument,
    cancelIndex,
    search,
    graphView,
    indexWarning,
    qaRounds,
    askState,
    askQuestion,
    cancelAsk,
    clearAsk,
    clearQaHistory,
    subscribeAsk,
    subscribeIndexProgress,
    renameDocument,
    removeDocument,
    openBaseDir,
    openFileDir,
    readFile,
    createShare,
    listShares,
    revokeShare,
    reset
  }
})
