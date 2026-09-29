import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import type {
  AutomationTemplateSyncStats,
  DesktopAutomationTemplate,
  WebUser
} from '../../../preload/index.d'

export type AutomationTemplateSyncState = 'unknown' | 'unauthorized' | 'authorized'

/**
 * 定时模板同步状态（镜像 expertSync store）。
 * - 本地文件（~/.ke-work/automation-templates/templates.json）为展示事实源；
 * - sync 期间订阅 automation-template-sync:progress 事件驱动进度条；
 * - 登出时 resetLocal 清空渲染层状态，避免账号切换残留。
 *
 * 模板列表不像专家那样被聊天/任务选择引用，因此直接放在本 store，
 * 不额外引入一份 catalog 状态。
 */
export const useAutomationTemplateSyncStore = defineStore('automationTemplateSync', () => {
  const status = ref<AutomationTemplateSyncState>('unknown')
  const webUser = ref<WebUser | null>(null)
  const lastSyncedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** 是否正在同步（进度条显示与按钮禁用依据） */
  const syncing = ref(false)
  /** 同步进度 0–100 */
  const percent = ref(0)
  const progressMessage = ref('')
  /** 最近一次同步的版本比对统计（新增 / 更新 / 保留本地） */
  const stats = ref<AutomationTemplateSyncStats | null>(null)
  /** 正在删除的模板 id（删除按钮禁用依据） */
  const removingId = ref<string | null>(null)
  /** 本地模板列表（磁盘事实源的回显） */
  const templates = ref<DesktopAutomationTemplate[]>([])
  /** 是否已同步过（区分「没同步过」与「同步过但服务端为空」） */
  const loaded = ref(false)

  async function loadStatus(): Promise<void> {
    const result = await window.api.automationTemplateSync.getStatus()
    if (!result.success) {
      status.value = 'unauthorized'
      error.value = result.error || '读取同步状态失败'
      return
    }
    status.value = result.data?.status ?? 'unauthorized'
    webUser.value = result.data?.webUser ?? null
    error.value = null
  }

  /** 读取 templates.json 并回显（页面挂载 / 同步完成后调用） */
  async function loadLocal(): Promise<void> {
    try {
      const result = await window.api.automationTemplateSync.loadLocal()
      if (!result.success) throw new Error(result.error || '读取本地模板失败')
      const data = result.data
      if (data) {
        templates.value = data.templates
        lastSyncedAt.value = data.syncedAt
        loaded.value = true
      }
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地模板失败'
    }
  }

  async function authorize(): Promise<void> {
    const result = await window.api.automationTemplateSync.authorize()
    if (!result.success) throw new Error(result.error || '授权失败')
    status.value = 'authorized'
    webUser.value = result.data?.webUser ?? null
  }

  /** 完整同步：授权（如需）→ 拉取 → 版本比对合并 → 落盘 → 读回展示；成功返回 true */
  async function sync(): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    error.value = null
    stats.value = null
    percent.value = 0
    progressMessage.value = '正在检查定时模板同步状态…'
    let unlisten: (() => void) | null = null
    try {
      if (status.value !== 'authorized') {
        percent.value = 5
        progressMessage.value = '正在等待浏览器授权…'
        await authorize()
      }
      percent.value = 10
      progressMessage.value = '正在拉取定时模板…'
      unlisten = window.api.automationTemplateSync.onSyncProgress((p) => {
        if (p.phase === 'error') return
        percent.value = p.percent
        progressMessage.value = p.message || progressMessage.value
      })
      const result = await window.api.automationTemplateSync.sync()
      if (!result.success) throw new Error(result.error || '同步失败')
      const data = result.data
      if (!data) throw new Error('同步结果为空')
      templates.value = data.templates
      lastSyncedAt.value = data.syncedAt
      stats.value = data.stats ?? null
      loaded.value = true
      percent.value = 100
      progressMessage.value = '定时模板同步完成'
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

  /**
   * 删除本地模板（仅本机副本）。
   *
   * 服务端仍存在的模板会在下次同步时按版本重新拉回；
   * 已用它建过的任务不受影响（任务的 templateId 只是来源标记）。
   */
  async function removeTemplate(templateId: string): Promise<boolean> {
    if (removingId.value) return false
    removingId.value = templateId
    error.value = null
    try {
      const result = await window.api.automationTemplateSync.deleteTemplate(templateId)
      if (!result.success) throw new Error(result.error || '删除模板失败')
      if (result.data) {
        templates.value = result.data.templates
        lastSyncedAt.value = result.data.syncedAt
      }
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除模板失败'
      return false
    } finally {
      removingId.value = null
    }
  }

  async function disconnect(): Promise<void> {
    const result = await window.api.automationTemplateSync.disconnect()
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
    stats.value = null
    removingId.value = null
    templates.value = []
    loaded.value = false
  }

  return {
    status,
    webUser,
    lastSyncedAt,
    error,
    syncing,
    percent,
    progressMessage,
    stats,
    removingId,
    templates,
    loaded,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    removeTemplate,
    disconnect,
    resetLocal
  }
})
