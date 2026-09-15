import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useSettingsStore } from './settings'
import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../preload/index.d'

/**
 * 知识库「按库覆盖」配置（渲染层）
 *
 * 主进程才是权威（校验 + 落盘 ~/.ke-work/knowledge/kb-settings.json），这里只做缓存与合成：
 * - 覆盖项**稀疏**：某 key 不存在 = 跟随全局
 * - 生效配置 = 全局值 ← 逐项覆盖，因此全局设置一变，未覆盖项自动跟着变（无需重新拉取）
 */
export const useKnowledgeSettingsStore = defineStore('knowledgeSettings', () => {
  const settingsStore = useSettingsStore()

  /** kbId → 覆盖项（稀疏；缺失或 {} 表示全部跟随全局） */
  const overridesByKb = ref<Record<string, KnowledgeOverrides>>({})
  /** 已从主进程拉取过的 kbId（避免弹窗重复请求） */
  const hydratedKbIds = ref<Record<string, boolean>>({})
  const loading = ref(false)
  const lastError = ref('')

  /** 全局 17 项值（短 key 形态，随「知识库设置」页变化而变） */
  const globalValues = computed<KnowledgeOverrides>(() => settingsStore.knowledgeGlobalValues)

  /** 某知识库的覆盖项（未配置返回 {}） */
  function overridesFor(kbId: string): KnowledgeOverrides {
    return overridesByKb.value[kbId] ?? {}
  }

  /** 是否被该知识库显式覆盖（必须看键是否存在：0 / false 也是合法覆盖值） */
  function isOverridden(kbId: string, key: KnowledgeOverrideKey): boolean {
    return Object.prototype.hasOwnProperty.call(overridesFor(kbId), key)
  }

  /** 生效配置 = 全局值 ← 逐项覆盖 */
  function effectiveFor(kbId: string): KnowledgeOverrides {
    return { ...globalValues.value, ...overridesFor(kbId) }
  }

  /**
   * 拉取覆盖项（省略 kbIds = 该用户全部已配置项）。
   * 主进程返回的每个 kbId 都标记为已加载（未配置项为 {}）。
   */
  async function load(kbIds?: string[]): Promise<boolean> {
    loading.value = true
    const result = await window.api.getKbSettings(kbIds)
    loading.value = false
    if (!result.success) {
      lastError.value = result.error ?? '读取知识库配置失败'
      return false
    }
    const data = result.data ?? {}
    overridesByKb.value = { ...overridesByKb.value, ...data }
    for (const kbId of Object.keys(data)) {
      hydratedKbIds.value[kbId] = true
    }
    for (const kbId of kbIds ?? []) {
      hydratedKbIds.value[kbId] = true
    }
    lastError.value = ''
    return true
  }

  /** 按需加载单个知识库（弹窗打开时调用）；已加载则跳过 */
  async function ensureLoaded(kbId: string): Promise<void> {
    if (hydratedKbIds.value[kbId]) return
    await load([kbId])
  }

  /**
   * 全量替换某知识库的覆盖项（传 {} 即恢复全部跟随全局）。
   * 成功以主进程返回值回填，失败不污染本地缓存（避免界面显示未真正落盘的值）。
   */
  async function saveOverrides(kbId: string, overrides: KnowledgeOverrides): Promise<boolean> {
    const result = await window.api.setKbSettings(kbId, overrides)
    if (!result.success) {
      lastError.value = result.error ?? '保存知识库配置失败'
      return false
    }
    overridesByKb.value = { ...overridesByKb.value, [kbId]: result.data ?? {} }
    hydratedKbIds.value[kbId] = true
    lastError.value = ''
    return true
  }

  return {
    overridesByKb,
    hydratedKbIds,
    loading,
    lastError,
    globalValues,
    overridesFor,
    isOverridden,
    effectiveFor,
    load,
    ensureLoaded,
    saveOverrides
  }
})
