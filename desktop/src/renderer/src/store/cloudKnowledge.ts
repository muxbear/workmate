import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  CloudKbScope,
  CloudKbSummary,
  CloudLoadState,
  CloudShareEntry
} from '../../../preload/index.d'

/**
 * 云知识库（只读）——侧栏三个云分组的数据源。
 *
 * - `personal` / `public`：云个人知识库 / 云公共知识库；
 * - `invitations`：共享给我的（待接受 + 已接受，与 Web 版侧栏同源）；
 * - 本地知识库仍归 `store/knowledge.ts`，两者不混。
 *
 * **未授权不是错误**：主进程返回 `state: 'auth-required'`，页面据此渲染「去授权」按钮、
 * 不弹浏览器（授权只能由用户主动点击触发）。
 */
export const useCloudKnowledgeStore = defineStore('cloudKnowledge', () => {
  const personal = ref<CloudKbSummary[]>([])
  const publicKbs = ref<CloudKbSummary[]>([])
  const invitations = ref<CloudShareEntry[]>([])
  /** 三个云分组共用的加载状态（未授权 / 失败 / 正常） */
  const state = ref<CloudLoadState>('ok')
  const message = ref('')
  /** Web 账号绑定与授权状态（决定提示文案：未登录 vs 缺权限） */
  const linked = ref(false)
  const hasScope = ref(false)
  const loading = ref(false)

  /** 待接受的分享邀请（侧栏角标） */
  function pendingInvitationCount(): number {
    return invitations.value.filter((item) => item.status === 'pending').length
  }

  async function loadStatus(): Promise<void> {
    const result = await window.api.knowledgeCloud.getStatus()
    if (!result.success) {
      linked.value = false
      hasScope.value = false
      return
    }
    linked.value = result.data?.linked ?? false
    hasScope.value = result.data?.hasScope ?? false
  }

  async function loadScope(scope: Exclude<CloudKbScope, 'shared_with_me'>): Promise<void> {
    const result = await window.api.knowledgeCloud.list({ scope, pageSize: 100 })
    if (!result.success) {
      applyState('error', result.error || '同步云知识库失败')
      return
    }
    const items = result.data?.items ?? []
    if (scope === 'personal') personal.value = items
    else publicKbs.value = items
    applyState(result.data?.state ?? 'ok', result.data?.message ?? '')
  }

  async function loadInvitations(): Promise<void> {
    const result = await window.api.knowledgeCloud.listInvitations()
    if (!result.success) {
      applyState('error', result.error || '同步共享记录失败')
      return
    }
    invitations.value = result.data?.items ?? []
    applyState(result.data?.state ?? 'ok', result.data?.message ?? '')
  }

  /**
   * 三个请求共用一份状态，按「越需要用户动作越优先」取：
   * auth-required（可点去授权）> error（可重试）> ok。
   */
  function applyState(next: CloudLoadState, text: string): void {
    const rank: Record<CloudLoadState, number> = { ok: 0, error: 1, 'auth-required': 2 }
    if (rank[next] > rank[state.value]) {
      state.value = next
      message.value = text
    }
  }

  /** 拉取三个云分组（页面挂载、刷新、授权成功后调用） */
  async function loadAll(): Promise<void> {
    loading.value = true
    state.value = 'ok'
    message.value = ''
    try {
      await loadStatus()
      // 未登录 Web 账号时不必发请求：结果只会是 auth-required
      if (!linked.value) {
        state.value = 'auth-required'
        message.value = '尚未绑定 Web 账号：请先在设置 - 账号 中登录'
        return
      }
      if (!hasScope.value) {
        state.value = 'auth-required'
        message.value = '需要授权「读取并检索知识库」后才能查看云端知识库'
        return
      }
      await Promise.all([loadScope('personal'), loadScope('public'), loadInvitations()])
    } finally {
      loading.value = false
    }
  }

  /** 接受 / 拒绝邀请；成功后刷新共享给我的列表 */
  async function respondInvitation(shareId: string, accept: boolean): Promise<boolean> {
    const result = await window.api.knowledgeCloud.respondInvitation(shareId, accept)
    if (!result.success) {
      message.value = result.error || '操作失败'
      return false
    }
    await loadInvitations()
    return true
  }

  /**
   * 用户主动授权的唯一入口（增量授权，允许打开浏览器）。
   * 授权成功后立即重拉，用户不必手动刷新。
   */
  async function authorize(): Promise<boolean> {
    const result = await window.api.oauth2.authorize(['knowledge:read'])
    if (!result.success) {
      state.value = 'error'
      message.value = result.error || '授权失败'
      return false
    }
    await loadAll()
    return true
  }

  /** 预览/下载用的按需读取（薄透传，错误交给调用方展示） */
  async function readFile(
    kbId: string,
    docId: string,
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
    const result = await window.api.knowledgeCloud.readFile(kbId, docId, as, cursor)
    if (!result.success || !result.data) {
      message.value = result.error || '读取云文档失败'
      return null
    }
    return result.data
  }

  async function downloadDocument(
    kbId: string,
    docId: string,
    suggestedName: string
  ): Promise<{ saved: boolean; path?: string } | null> {
    const result = await window.api.knowledgeCloud.downloadDocument(kbId, docId, suggestedName)
    if (!result.success || !result.data) {
      message.value = result.error || '下载失败'
      return null
    }
    return result.data
  }

  /** 登出：清空渲染层状态，避免账号切换残留 */
  function reset(): void {
    personal.value = []
    publicKbs.value = []
    invitations.value = []
    state.value = 'ok'
    message.value = ''
    linked.value = false
    hasScope.value = false
  }

  return {
    personal,
    publicKbs,
    invitations,
    state,
    message,
    linked,
    hasScope,
    loading,
    pendingInvitationCount,
    loadStatus,
    loadScope,
    loadInvitations,
    loadAll,
    respondInvitation,
    authorize,
    readFile,
    downloadDocument,
    reset
  }
})
