import { defineStore } from 'pinia'
import { registerResettable } from './sessionReset'
import { createSyncCore, type SyncCoreState } from './syncCore'
import type { DesktopExpert, ExpertSyncStats } from '../../../shared/contracts'
import { useCatalogStore } from './catalog'

export type ExpertSyncState = SyncCoreState

/** 同步/本地读取的载荷（expert-sync:* 通道的 data 形态；stats 仅同步结果携带） */
interface ExpertSyncPayload {
  experts: DesktopExpert[]
  syncedAt: number
  stats?: ExpertSyncStats
}

/**
 * 专家同步状态（薄壳；骨架与文案见 syncCore，域逻辑只有结果写入 expert 广场与删除流程）。
 * - 本地文件（~/.ke-work/experts/experts.json）为展示事实源；
 * - sync 期间订阅 expert-sync:progress 事件驱动进度条；
 * - 登出时 resetLocal 清空渲染层状态，避免账号切换残留。
 */
export const useExpertSyncStore = defineStore('expertSync', () => {
  const catalog = useCatalogStore()

  const core = createSyncCore<ExpertSyncPayload, ExpertSyncStats>({
    api: () => window.api.expert,
    texts: {
      checking: '正在检查专家同步状态…',
      fetching: '正在拉取专家数据…',
      done: '专家数据同步完成',
      loadLocalFailed: '读取本地专家失败',
      removeFailed: '删除专家失败'
    },
    applyLocal: (data) => catalog.setExperts(data.experts),
    readSyncedAt: (data) => data.syncedAt,
    readStats: (data) => data.stats ?? null,
    clearLocal: () => catalog.clearExpertItems()
  })

  /**
   * 删除本地专家（仅本机副本）。
   *
   * 服务端仍存在的专家会在下次同步时按版本重新拉回；若删的正是在用专家，
   * 一并取消选择（输入框内的专家提示词由 PromptInput 的 watcher 自动剔除）。
   */
  async function removeExpert(expertId: string): Promise<boolean> {
    return core.runRemoval(expertId, async (id) => {
      const result = await window.api.expert.deleteExpert(id)
      if (!result.success) throw new Error(result.error || '删除专家失败')
      catalog.removeExpertItem(id)
      if (catalog.selectedExpertId === id) catalog.clearExpert()
      if (result.data) core.lastSyncedAt.value = result.data.syncedAt
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
    loadStatus,
    loadLocal,
    authorize,
    sync,
    removeExpert,
    disconnect,
    resetLocal
  }
})

// 登出 / 会话失效时重置本域（session-reset 注册表；惰性取实例）
registerResettable(() => useExpertSyncStore().resetLocal())
