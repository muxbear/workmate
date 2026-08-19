import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DesktopSkill, WebUser } from '../../../preload/index.d'
import { useCatalogStore } from './catalog'

export type SkillSyncState = 'unknown' | 'unauthorized' | 'authorized' | 'syncing'

export const useSkillSyncStore = defineStore('skillSync', () => {
  const catalog = useCatalogStore()

  const status = ref<SkillSyncState>('unknown')
  const skills = ref<DesktopSkill[]>([])
  const lastSyncedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  const webUser = ref<WebUser | null>(null)

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

  async function authorize(): Promise<void> {
    status.value = 'syncing'
    error.value = null
    try {
      const result = await window.api.skillSync.authorize()
      if (!result.success) {
        status.value = 'unauthorized'
        throw new Error(result.error || '授权失败')
      }
      webUser.value = result.data?.webUser ?? null
      status.value = 'authorized'
    } catch (err) {
      status.value = 'unauthorized'
      error.value = err instanceof Error ? err.message : '授权失败'
      throw err
    }
  }

  async function sync(): Promise<void> {
    status.value = 'syncing'
    error.value = null
    try {
      const result = await window.api.skillSync.sync()
      if (!result.success) {
        throw new Error(result.error || '同步失败')
      }
      skills.value = result.data?.skills ?? []
      lastSyncedAt.value = result.data?.syncedAt ?? Date.now()
      catalog.setSkills(result.data?.skills ?? [])
      status.value = 'authorized'
    } catch (err) {
      status.value = webUser.value ? 'authorized' : 'unauthorized'
      error.value = err instanceof Error ? err.message : '同步失败'
      throw err
    }
  }

  async function loadCachedSkills(): Promise<void> {
    const result = await window.api.skillSync.getCachedSkills()
    if (!result.success) {
      error.value = result.error || '读取缓存失败'
      return
    }
    skills.value = result.data ?? []
    catalog.setSkills(result.data ?? [])
  }

  async function disconnect(): Promise<void> {
    const result = await window.api.skillSync.disconnect()
    if (!result.success) {
      error.value = result.error || '断开连接失败'
      return
    }
    resetLocal()
  }

  function resetLocal(): void {
    status.value = 'unknown'
    skills.value = []
    lastSyncedAt.value = null
    error.value = null
    webUser.value = null
    catalog.clearSkillItems()
    catalog.clearSkills()
  }

  return {
    status,
    skills,
    lastSyncedAt,
    error,
    webUser,
    loadStatus,
    authorize,
    sync,
    loadCachedSkills,
    disconnect,
    resetLocal
  }
})
