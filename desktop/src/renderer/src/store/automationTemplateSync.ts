import { defineStore } from 'pinia'
import { ref } from 'vue'
import { registerResettable } from './sessionReset'
import { createSyncCore, type SyncCoreState } from './syncCore'
import type { AutomationTemplateSyncStats, DesktopAutomationTemplate } from '../../../shared/contracts'

export type AutomationTemplateSyncState = SyncCoreState

/** 同步/本地读取的载荷（automation-template-sync:* 通道的 data 形态；stats 仅同步结果携带） */
interface AutomationTemplateSyncPayload {
  templates: DesktopAutomationTemplate[]
  syncedAt: number
  stats?: AutomationTemplateSyncStats
}

/**
 * 定时模板同步状态（薄壳；骨架与文案见 syncCore，域逻辑只有模板列表的回显与删除流程）。
 * - 本地文件（~/.ke-work/automation-templates/templates.json）为展示事实源；
 * - sync 期间订阅 automation-template-sync:progress 事件驱动进度条；
 * - 登出时 resetLocal 清空渲染层状态，避免账号切换残留。
 *
 * 模板列表不像专家那样被聊天/任务选择引用，因此直接放在本 store，
 * 不额外引入一份 catalog 状态。
 */
export const useAutomationTemplateSyncStore = defineStore('automationTemplateSync', () => {
  /** 本地模板列表（磁盘事实源的回显） */
  const templates = ref<DesktopAutomationTemplate[]>([])
  /** 是否已同步过（区分「没同步过」与「同步过但服务端为空」） */
  const loaded = ref(false)

  const core = createSyncCore<AutomationTemplateSyncPayload, AutomationTemplateSyncStats>({
    api: () => window.api.automationTemplateSync,
    texts: {
      checking: '正在检查定时模板同步状态…',
      fetching: '正在拉取定时模板…',
      done: '定时模板同步完成',
      loadLocalFailed: '读取本地模板失败',
      removeFailed: '删除模板失败'
    },
    applyLocal: (data) => {
      templates.value = data.templates
      loaded.value = true
    },
    readSyncedAt: (data) => data.syncedAt,
    readStats: (data) => data.stats ?? null,
    clearLocal: () => {
      templates.value = []
      loaded.value = false
    }
  })

  /**
   * 删除本地模板（仅本机副本）。
   *
   * 服务端仍存在的模板会在下次同步时按版本重新拉回；
   * 已用它建过的任务不受影响（任务的 templateId 只是来源标记）。
   */
  async function removeTemplate(templateId: string): Promise<boolean> {
    return core.runRemoval(templateId, async (id) => {
      const result = await window.api.automationTemplateSync.deleteTemplate(id)
      if (!result.success) throw new Error(result.error || '删除模板失败')
      if (result.data) {
        templates.value = result.data.templates
        core.lastSyncedAt.value = result.data.syncedAt
      }
    })
  }

  const {
    status,
    webUser,
    lastSyncedAt,
    error,
    syncing,
    percent,
    progressMessage,
    stats,
    removingId,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    disconnect,
    resetLocal
  } = core

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

// 登出 / 会话失效时重置本域（session-reset 注册表；惰性取实例）
registerResettable(() => useAutomationTemplateSyncStore().resetLocal())
