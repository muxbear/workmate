import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import type {
  DesktopSkill,
  SkillInstallProgress,
  SkillSyncStats,
  WebUser
} from '../../../preload/index.d'
import { useCatalogStore } from './catalog'

export type SkillSyncState = 'unknown' | 'unauthorized' | 'authorized' | 'syncing'

/**
 * 技能同步与安装状态（本地优先）。
 *
 * - ~/.ke-work/skills/skills.json 为展示事实源：页面挂载先 loadLocal，服务端同步只做增量更新；
 * - 同步 / 安装期间订阅主进程进度事件驱动 UI；
 * - 登出时 resetLocal 清空渲染层状态，磁盘技能包与运行环境保留。
 */
export const useSkillSyncStore = defineStore('skillSync', () => {
  const catalog = useCatalogStore()

  const status = ref<SkillSyncState>('unknown')
  const skills = ref<DesktopSkill[]>([])
  const lastSyncedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  const webUser = ref<WebUser | null>(null)
  /** 同步中（进度条显示与按钮禁用依据） */
  const syncing = ref(false)
  const percent = ref(0)
  const progressMessage = ref('')
  /** 最近一次同步的增量统计 */
  const stats = ref<SkillSyncStats | null>(null)
  /** 正在安装 / 卸载的技能 id */
  const installingId = ref<string | null>(null)
  const installMessage = ref('')

  /** 用新列表替换技能页数据（同时同步 catalog store） */
  function applySkills(items: DesktopSkill[]): void {
    skills.value = items
    catalog.setSkills(items)
  }

  async function loadStatus(): Promise<void> {
    const result = await window.api.skillSync.getStatus()
    if (!result.success) {
      status.value = 'unauthorized'
      error.value = result.error || '读取同步状态失败'
      return
    }
    status.value = result.data?.status ?? 'unauthorized'
    webUser.value = result.data?.webUser ?? null
    error.value = null
  }

  /** 读取 ~/.ke-work/skills/skills.json 并刷新技能页（页面挂载首选） */
  async function loadLocal(): Promise<boolean> {
    try {
      const result = await window.api.skillSync.loadLocal()
      if (!result.success) throw new Error(result.error || '读取本地技能失败')
      const data = result.data
      if (data) {
        applySkills(data.skills)
        lastSyncedAt.value = data.syncedAt
      }
      error.value = null
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地技能失败'
      return false
    }
  }

  async function authorize(): Promise<void> {
    const result = await window.api.skillSync.authorize()
    if (!result.success) throw new Error(result.error || '授权失败')
    status.value = 'authorized'
    webUser.value = result.data?.webUser ?? null
  }

  /** 重新同步：授权（如需）→ 拉列表 → 增量下载 → 落盘 → 读回 */
  async function sync(): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    error.value = null
    stats.value = null
    percent.value = 0
    progressMessage.value = '正在检查技能同步状态…'
    let unlisten: (() => void) | null = null
    try {
      if (status.value !== 'authorized') {
        percent.value = 5
        progressMessage.value = '正在等待浏览器授权…'
        await authorize()
      }
      percent.value = 10
      progressMessage.value = '正在拉取技能列表…'
      unlisten = window.api.skillSync.onSyncProgress((progress) => {
        if (progress.phase === 'error') return
        percent.value = progress.percent
        progressMessage.value = progress.message || progressMessage.value
      })
      const result = await window.api.skillSync.sync()
      if (!result.success) throw new Error(result.error || '同步失败')
      const data = result.data
      if (!data) throw new Error('同步结果为空')
      applySkills(data.skills)
      lastSyncedAt.value = data.syncedAt
      stats.value = data.stats
      percent.value = 100
      progressMessage.value = '技能同步完成'
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

  /** 安装技能到主智能体（含脚本运行时环境准备） */
  async function install(skillId: string): Promise<boolean> {
    if (installingId.value) return false
    installingId.value = skillId
    error.value = null
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
      error.value = err instanceof Error ? err.message : '技能安装失败'
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
    error.value = null
    try {
      const result = await window.api.skillSync.uninstall(skillId)
      if (!result.success) throw new Error(result.error || '卸载失败')
      if (result.data?.skill) patchSkill(result.data.skill)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '卸载失败'
      return false
    } finally {
      installingId.value = null
    }
  }

  /** 兼容旧入口：读取主进程内存缓存（本地文件优先，缓存通常为空） */
  async function loadCachedSkills(): Promise<void> {
    const result = await window.api.skillSync.getCachedSkills()
    if (!result.success) {
      error.value = result.error || '读取缓存失败'
      return
    }
    if ((result.data ?? []).length > 0) applySkills(result.data ?? [])
  }

  async function disconnect(): Promise<void> {
    const result = await window.api.skillSync.disconnect()
    if (!result.success) {
      error.value = result.error || '断开连接失败'
      return
    }
    resetLocal()
  }

  /** 局部更新单个技能（安装 / 卸载后避免整页刷新） */
  function patchSkill(updated: DesktopSkill): void {
    applySkills(
      skills.value.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
    )
  }

  function resetLocal(): void {
    status.value = 'unknown'
    skills.value = []
    lastSyncedAt.value = null
    error.value = null
    webUser.value = null
    syncing.value = false
    percent.value = 0
    progressMessage.value = ''
    stats.value = null
    installingId.value = null
    installMessage.value = ''
    catalog.clearSkillItems()
    catalog.clearSkills()
  }

  return {
    status,
    skills,
    lastSyncedAt,
    error,
    webUser,
    syncing,
    percent,
    progressMessage,
    stats,
    installingId,
    installMessage,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    install,
    uninstall,
    loadCachedSkills,
    disconnect,
    resetLocal
  }
})
