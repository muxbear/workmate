import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RuntimeId, RuntimeInfo, RuntimeProgress } from '../../../preload/index.d'

/**
 * 内置运行时 Store（渲染层）
 *
 * - load：从主进程拉取运行时列表（安全中心页面打开时调用）
 * - toggle：切换单个运行时开关（通过 settingsStore 持久化 → 主进程刷新 enabled 状态）
 * - install / uninstall：调用 IPC → 刷新列表
 * - progress：安装期间通过 onRuntimeProgress 事件实时更新进度
 */
export const useRuntimeStore = defineStore('runtime', () => {
  const runtimes = ref<RuntimeInfo[]>([])
  const loaded = ref(false)
  const loading = ref(false)

  /** 各运行时安装进度（id → RuntimeProgress） */
  const progressMap = ref<Record<string, RuntimeProgress>>({})

  /** 正在安装中的运行时 id 集合 */
  const installingIds = ref<Set<string>>(new Set())

  /** 进度事件监听器清理函数 */
  let unlistenProgress: (() => void) | null = null

  /** 订阅主进程的进度事件 */
  function subscribeProgress(): void {
    if (unlistenProgress) return
    unlistenProgress = window.api.onRuntimeProgress((data) => {
      progressMap.value[data.id] = data

      if (data.phase === 'downloading' || data.phase === 'extracting' || data.phase === 'verifying') {
        installingIds.value.add(data.id)
      } else if (data.phase === 'done' || data.phase === 'error') {
        installingIds.value.delete(data.id)
      }
    })
  }

  /** 判断指定运行时是否正在安装 */
  function isInstalling(id: RuntimeId): boolean {
    return installingIds.value.has(id)
  }

  /** 从主进程拉取运行时列表 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      const result = await window.api.listRuntimes()
      if (result.success && result.data) {
        runtimes.value = result.data
      }
      loaded.value = true
    } catch (err) {
      console.warn('[runtime] load failed:', err)
    } finally {
      loading.value = false
    }
  }

  /** 切换单个运行时开关 */
  async function toggle(id: RuntimeId, enabled: boolean): Promise<void> {
    const key = `runtime.${id}.enabled`
    try {
      await window.api.setSetting(key, enabled)
      // 刷新列表以获取主进程的最新 enabled 状态
      await load()
    } catch (err) {
      console.warn(`[runtime] toggle ${id} failed:`, err)
      await load()
    }
  }

  /** 安装运行时 */
  async function install(id: RuntimeId, version?: string): Promise<void> {
    subscribeProgress()
    installingIds.value.add(id)

    try {
      const result = await window.api.installRuntime(id, version)
      if (result.success && result.data) {
        runtimes.value = result.data
      } else if (!result.success) {
        throw new Error(result.error)
      }
    } catch (err) {
      console.error(`[runtime] install ${id} failed:`, err)
      throw err
    } finally {
      installingIds.value.delete(id)
      delete progressMap.value[id]
    }
  }

  /** 卸载运行时 */
  async function uninstall(id: RuntimeId): Promise<void> {
    try {
      const result = await window.api.uninstallRuntime(id)
      if (result.success && result.data) {
        runtimes.value = result.data
      } else if (!result.success) {
        throw new Error(result.error)
      }
    } catch (err) {
      console.error(`[runtime] uninstall ${id} failed:`, err)
      throw err
    }
  }

  /** 探测运行时版本 */
  async function detect(id: RuntimeId): Promise<string | null> {
    try {
      const result = await window.api.detectRuntime(id)
      if (result.success) {
        return result.data ?? null
      }
      return null
    } catch (err) {
      console.warn(`[runtime] detect ${id} failed:`, err)
      return null
    }
  }

  return {
    runtimes,
    loaded,
    loading,
    progressMap,
    installingIds,
    load,
    toggle,
    install,
    uninstall,
    detect,
    isInstalling,
    subscribeProgress
  }
})