import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import { registerResettable } from './sessionReset'
import { createSyncCore, type SyncCoreState } from './syncCore'
import type { DesktopSkill, SkillInstallProgress, SkillSyncStats } from '../../../shared/contracts'
import { useCatalogStore } from './catalog'

export type SkillSyncState = SyncCoreState

/** 同步/本地读取的载荷（skill-sync:* 通道的 data 形态；stats 仅同步结果携带） */
interface SkillSyncPayload {
  skills: DesktopSkill[]
  syncedAt: number
  stats?: SkillSyncStats
}

/**
 * 技能同步与安装状态（本地优先）。
 *
 * 同步骨架与文案见 syncCore；本薄壳承载技能域专有的安装/卸载/缓存读取：
 * - ~/.ke-work/skills/skills.json 为展示事实源：页面挂载先 loadLocal，服务端同步只做增量更新；
 * - 同步 / 安装期间订阅主进程进度事件驱动 UI；
 * - 登出时 resetLocal 清空渲染层状态，磁盘技能包与运行环境保留。
 */
export const useSkillSyncStore = defineStore('skillSync', () => {
  const catalog = useCatalogStore()

  /** 正在安装 / 卸载的技能 id */
  const installingId = ref<string | null>(null)
  const installMessage = ref('')

  const core = createSyncCore<SkillSyncPayload, SkillSyncStats>({
    api: () => window.api.skillSync,
    texts: {
      checking: '正在检查技能同步状态…',
      fetching: '正在拉取技能列表…',
      done: '技能同步完成',
      loadLocalFailed: '读取本地技能失败',
      removeFailed: '删除失败'
    },
    applyLocal: (data) => applySkills(data.skills),
    readSyncedAt: (data) => data.syncedAt,
    readStats: (data) => data.stats ?? null,
    clearLocal: () => {
      installingId.value = null
      installMessage.value = ''
      catalog.clearSkillItems()
      catalog.clearSkills()
    }
  })

  /** 用新列表替换技能页数据（单一事实源在 catalog.skillItems，本 store 不自持副本） */
  function applySkills(items: DesktopSkill[]): void {
    catalog.setSkills(items)
  }

  /** 安装技能到主智能体（含脚本运行时环境准备） */
  async function install(skillId: string): Promise<boolean> {
    if (installingId.value) return false
    installingId.value = skillId
    core.error.value = null
    installMessage.value = '正在准备安装…'
    let unlisten: (() => void) | null = null
    try {
      unlisten = window.api.skillSync.onInstallProgress((progress: SkillInstallProgress) => {
        if (progress.skillId !== skillId || progress.phase === 'error') return
        installMessage.value = progress.message || installMessage.value
      })
      const result = await window.api.skillSync.install(skillId)
      if (!result.success) throw new Error(result.error || '技能安装失败')
      if (result.data?.skill) patchSkill(result.data.skill)
      installMessage.value = '安装完成'
      await nextTick()
      return true
    } catch (err) {
      core.error.value = err instanceof Error ? err.message : '技能安装失败'
      return false
    } finally {
      if (unlisten) unlisten()
      installingId.value = null
    }
  }

  /** 从主智能体移除技能（保留本地技能包） */
  async function uninstall(skillId: string): Promise<boolean> {
    if (installingId.value) return false
    installingId.value = skillId
    core.error.value = null
    try {
      const result = await window.api.skillSync.uninstall(skillId)
      if (!result.success) throw new Error(result.error || '卸载失败')
      if (result.data?.skill) patchSkill(result.data.skill)
      return true
    } catch (err) {
      core.error.value = err instanceof Error ? err.message : '卸载失败'
      return false
    } finally {
      installingId.value = null
    }
  }

  /** 删除本地技能（卸载 + 删包；重新同步时以服务端为准） */
  async function remove(skillId: string): Promise<boolean> {
    return core.runRemoval(skillId, async (id) => {
      const result = await window.api.skillSync.delete(id)
      if (!result.success) throw new Error(result.error || '删除失败')
      applySkills(catalog.skillItems.filter((item) => item.id !== id))
    })
  }

  /** 兼容旧入口：读取主进程内存缓存（本地文件优先，缓存通常为空） */
  async function loadCachedSkills(): Promise<void> {
    const result = await window.api.skillSync.getCachedSkills()
    if (!result.success) {
      core.error.value = result.error || '读取缓存失败'
      return
    }
    if ((result.data ?? []).length > 0) applySkills(result.data ?? [])
  }

  /** 局部更新单个技能（安装 / 卸载后避免整页刷新） */
  function patchSkill(updated: DesktopSkill): void {
    applySkills(
      catalog.skillItems.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
    )
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
    installingId,
    removingId,
    installMessage,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    install,
    uninstall,
    remove,
    loadCachedSkills,
    disconnect,
    resetLocal
  }
})

// 登出 / 会话失效时重置本域（session-reset 注册表；惰性取实例）
registerResettable(() => useSkillSyncStore().resetLocal())
