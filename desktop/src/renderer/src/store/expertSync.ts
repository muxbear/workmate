import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import type { WebUser } from '../../../preload/index.d'
import { useCatalogStore } from './catalog'

export type ExpertSyncState = 'unknown' | 'unauthorized' | 'authorized'

/**
 * 专家同步状态（镜像 skillSync store）。
 * - 本地文件（~/.ke-work/experts/experts.json）为展示事实源；
 * - sync 期间订阅 expert-sync:progress 事件驱动进度条；
 * - 登出时 resetLocal 清空渲染层状态，避免账号切换残留。
 */
export const useExpertSyncStore = defineStore('expertSync', () => {
  const catalog = useCatalogStore()

  const status = ref<ExpertSyncState>('unknown')
  const webUser = ref<WebUser | null>(null)
  const lastSyncedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** 是否正在同步 / 加载本地专家（进度条显示与按钮禁用依据） */
  const syncing = ref(false)
  /** 同步进度 0–100 */
  const percent = ref(0)
  const progressMessage = ref('')

  async function loadStatus(): Promise<void> {
    const result = await window.api.expert.getStatus()
    if (!result.success) {
      status.value = 'unauthorized'
      error.value = result.error || '读取同步状态失败'
      return
    }
    status.value = result.data?.status ?? 'unauthorized'
    webUser.value = result.data?.webUser ?? null
    error.value = null
  }

  /** 读取 experts.json 并写入专家广场（页面挂载 / 同步完成后调用） */
  async function loadLocal(): Promise<void> {
    try {
      const result = await window.api.expert.loadLocal()
      if (!result.success) throw new Error(result.error || '读取本地专家失败')
      const data = result.data
      if (data) {
        catalog.setExperts(data.experts)
        lastSyncedAt.value = data.syncedAt
      }
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地专家失败'
    }
  }

  async function authorize(): Promise<void> {
    const result = await window.api.expert.authorize()
    if (!result.success) throw new Error(result.error || '授权失败')
    status.value = 'authorized'
    webUser.value = result.data?.webUser ?? null
  }

  /** 完整同步：授权（如需）→ 拉取 → 落盘 → 读回展示；成功返回 true */
  async function sync(): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    error.value = null
    percent.value = 0
    progressMessage.value = '正在检查专家同步状态…'
    let unlisten: (() => void) | null = null
    try {
      if (status.value !== 'authorized') {
        percent.value = 5
        progressMessage.value = '正在等待浏览器授权…'
        await authorize()
      }
      percent.value = 10
      progressMessage.value = '正在拉取专家数据…'
      unlisten = window.api.expert.onSyncProgress((p) => {
        if (p.phase === 'error') return
        percent.value = p.percent
        progressMessage.value = p.message || progressMessage.value
      })
      const result = await window.api.expert.sync()
      if (!result.success) throw new Error(result.error || '同步失败')
      const data = result.data
      if (!data) throw new Error('同步结果为空')
      catalog.setExperts(data.experts)
      lastSyncedAt.value = data.syncedAt
      percent.value = 100
      progressMessage.value = '专家数据同步完成'
      await nextTick()
      return true
    } catch (err) {
      status.value = webUser.value ? 'authorized' : 'unauthorized'
      error.value = err instanceof Error ? err.message : '同步失败'
      percent.value = 0
      return false
    } finally {
      if (unlisten) unlisten()
      syncing.value = false
    }
  }

  async function disconnect(): Promise<void> {
    const result = await window.api.expert.disconnect()
    if (!result.success) {
      error.value = result.error || '断开连接失败'
      return
    }
    resetLocal()
  }

  function resetLocal(): void {
    status.value = 'unknown'
    webUser.value = null
    lastSyncedAt.value = null
    error.value = null
    syncing.value = false
    percent.value = 0
    progressMessage.value = ''
    catalog.clearExpertItems()
  }

  return {
    status,
    webUser,
    lastSyncedAt,
    error,
    syncing,
    percent,
    progressMessage,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    disconnect,
    resetLocal
  }
})
