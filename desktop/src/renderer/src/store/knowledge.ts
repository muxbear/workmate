import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  IpcResult,
  KnowledgeBaseSummary,
  KnowledgeDocumentMeta,
  KnowledgeKind,
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
 * - 索引与问答尚未实现：文档的 `indexState` 恒为 `none`，`ask` 相关状态暂无。
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
    const result = await call(() => window.api.listKnowledgeBases(kind ? { kind } : undefined), IPC_FALLBACK)
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

  async function importDocuments(
    kbId: string,
    items: Array<{ srcPath: string; relPath: string }>
  ): Promise<{ accepted: number; skipped: number; failed: number; message: string } | null> {
    // 索引能力未开放：统一按「只上传文件」提交
    const result = await call(() => window.api.importKnowledgeDocuments(kbId, items, 'none'), IPC_FALLBACK)
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

  async function renameDocument(
    kbId: string,
    relPath: string,
    newName: string
  ): Promise<{ relPath: string } | null> {
    const result = await call(() => window.api.renameKnowledgeDocument(kbId, relPath, newName), IPC_FALLBACK)
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
    as: 'text' | 'bytes'
  ): Promise<{ content?: string; bytes?: Uint8Array; ext: string; name: string } | null> {
    const result = await call(() => window.api.readKnowledgeFile(kbId, relPath, as), IPC_FALLBACK)
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
    importDocuments,
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
