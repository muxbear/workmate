import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useWorkspaceStore } from './workspace'

/** 系统设置存储 key（与主进程 settings/schema.ts 对齐；嵌套路径扁平化） */
export type SettingsKey =
  | 'ui.language'
  | 'ui.fontSize'
  | 'ui.theme'
  | 'skills.autoUpdate'
  | 'skills.safeInstall'
  | 'plugins.autoUpdate'
  | 'lockScreen.remoteLock'
  | 'network.proxyMode'
  | 'network.proxyUrl'
  | 'workspace.defaultWorkspaceDir'
  | 'privacy.experienceImprovement'
  | 'notification.clientNotifications'
  | 'notification.sound'
  | 'runtime.enabled'
  | 'runtime.python.enabled'
  | 'runtime.node.enabled'
  | 'runtime.git.enabled'
  | 'knowledge.directory'
  | 'knowledge.maxUploadSize'
  | 'knowledge.uploadTimeout'
  | 'knowledge.maxFilesPerBatch'
  | 'knowledge.chunkStrategy'
  | 'knowledge.chunkSize'
  | 'knowledge.chunkOverlap'
  | 'knowledge.vectorDimensions'
  | 'knowledge.embeddingModel'
  | 'knowledge.sparseRetrieval'
  | 'knowledge.bm25K1'
  | 'knowledge.bm25B'
  | 'knowledge.hybridWeight'
  | 'knowledge.rerankEnabled'
  | 'knowledge.rerankModel'
  | 'knowledge.topK'
  | 'knowledge.graphEnabled'
  | 'knowledge.graphModel'

export type Language = 'zh-CN' | 'zh-TW' | 'en'
export type ThemeName = 'light' | 'dark'
export type ProxyMode = 'direct' | 'system' | 'manual'
export type NotificationSound = 'none' | 'crisp' | 'soft'
export type ChunkStrategy = 'semantic' | 'fixed' | 'markdown' | 'recursive'
export type VectorDimensions = 1024 | 1536 | 3072

export const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

interface SettingsMeta {
  dataBaseDir: string
  defaultWorkspaceDir: string
  defaultKnowledgeDir: string
}

interface StorageStats {
  baseDir: string
  usedBytes: number
  diskTotal: number
  diskFree: number
  partial?: boolean
}

/** 渲染层首帧默认值（与主进程 schema 一致；load() 后以主进程为准） */
const DEFAULT_FONT_SIZE = 17

/**
 * 系统设置（渲染层，对齐 workMode.ts 的 "store ↔ IPC 同步" 范本）
 * - load：App 挂载后调用，主进程默认值合并快照回填 12 字段 + 应用运行时效果
 * - set：乐观更新 → 300ms 防抖合并 → IPC → 失败回滚（重新 load）
 * - 即时生效：字体缩放 webFrame.setZoomFactor（语言 i18n P2 接入）
 */
export const useSettingsStore = defineStore('settings', () => {
  const language = ref<Language>('zh-CN')
  const fontSize = ref(DEFAULT_FONT_SIZE)
  const theme = ref<ThemeName>('light')
  const skillAutoUpdate = ref(true)
  const pluginAutoUpdate = ref(true)
  const safeSkillInstall = ref(false)
  const remoteLock = ref(false)
  const proxyMode = ref<ProxyMode>('direct')
  const proxyUrl = ref('')
  const defaultWorkspaceDir = ref('')
  const experienceImprovement = ref(true)
  const clientNotifications = ref(true)
  const notificationSound = ref<NotificationSound>('none')
  const runtimeEnabled = ref(true)
  const runtimePythonEnabled = ref(true)
  const runtimeNodeEnabled = ref(true)
  const runtimeGitEnabled = ref(true)
  // ── 知识库配置（「知识库设置」页） ──
  const knowledgeDirectory = ref('')
  const knowledgeMaxUploadSize = ref(100)
  const knowledgeUploadTimeout = ref(10)
  const knowledgeMaxFilesPerBatch = ref(20)
  const knowledgeChunkStrategy = ref<ChunkStrategy>('semantic')
  const knowledgeChunkSize = ref(800)
  const knowledgeChunkOverlap = ref(120)
  const knowledgeVectorDimensions = ref<VectorDimensions>(1024)
  const knowledgeEmbeddingModel = ref('text-embedding-3-large')
  const knowledgeSparseRetrieval = ref(true)
  const knowledgeBm25K1 = ref(1.5)
  const knowledgeBm25B = ref(0.75)
  const knowledgeHybridWeight = ref(0.65)
  const knowledgeRerankEnabled = ref(true)
  const knowledgeRerankModel = ref('bge-reranker-v2-m3')
  const knowledgeTopK = ref(12)
  const knowledgeGraphEnabled = ref(false)
  const knowledgeGraphModel = ref('GLM-5')

  const meta = ref<SettingsMeta>()
  const storageStats = ref<StorageStats | null>(null)
  const loaded = ref(false)

  /** key → 响应式字段 映射（set/load 统一入口；主进程已校验，此处直接强转） */
  function applyToField(key: string, value: unknown): void {
    switch (key) {
      case 'ui.language':
        language.value = value as Language
        break
      case 'ui.fontSize':
        fontSize.value = value as number
        break
      case 'ui.theme':
        theme.value = value as ThemeName
        break
      case 'skills.autoUpdate':
        skillAutoUpdate.value = value as boolean
        break
      case 'skills.safeInstall':
        safeSkillInstall.value = value as boolean
        break
      case 'plugins.autoUpdate':
        pluginAutoUpdate.value = value as boolean
        break
      case 'lockScreen.remoteLock':
        remoteLock.value = value as boolean
        break
      case 'network.proxyMode':
        proxyMode.value = value as ProxyMode
        break
      case 'network.proxyUrl':
        proxyUrl.value = value as string
        break
      case 'workspace.defaultWorkspaceDir':
        defaultWorkspaceDir.value = value as string
        break
      case 'privacy.experienceImprovement':
        experienceImprovement.value = value as boolean
        break
      case 'notification.clientNotifications':
        clientNotifications.value = value as boolean
        break
      case 'notification.sound':
        notificationSound.value = value as NotificationSound
        break
      case 'runtime.enabled':
        runtimeEnabled.value = value as boolean
        break
      case 'runtime.python.enabled':
        runtimePythonEnabled.value = value as boolean
        break
      case 'runtime.node.enabled':
        runtimeNodeEnabled.value = value as boolean
        break
      case 'runtime.git.enabled':
        runtimeGitEnabled.value = value as boolean
        break
      case 'knowledge.directory':
        knowledgeDirectory.value = value as string
        break
      case 'knowledge.maxUploadSize':
        knowledgeMaxUploadSize.value = value as number
        break
      case 'knowledge.uploadTimeout':
        knowledgeUploadTimeout.value = value as number
        break
      case 'knowledge.maxFilesPerBatch':
        knowledgeMaxFilesPerBatch.value = value as number
        break
      case 'knowledge.chunkStrategy':
        knowledgeChunkStrategy.value = value as ChunkStrategy
        break
      case 'knowledge.chunkSize':
        knowledgeChunkSize.value = value as number
        break
      case 'knowledge.chunkOverlap':
        knowledgeChunkOverlap.value = value as number
        break
      case 'knowledge.vectorDimensions':
        knowledgeVectorDimensions.value = value as VectorDimensions
        break
      case 'knowledge.embeddingModel':
        knowledgeEmbeddingModel.value = value as string
        break
      case 'knowledge.sparseRetrieval':
        knowledgeSparseRetrieval.value = value as boolean
        break
      case 'knowledge.bm25K1':
        knowledgeBm25K1.value = value as number
        break
      case 'knowledge.bm25B':
        knowledgeBm25B.value = value as number
        break
      case 'knowledge.hybridWeight':
        knowledgeHybridWeight.value = value as number
        break
      case 'knowledge.rerankEnabled':
        knowledgeRerankEnabled.value = value as boolean
        break
      case 'knowledge.rerankModel':
        knowledgeRerankModel.value = value as string
        break
      case 'knowledge.topK':
        knowledgeTopK.value = value as number
        break
      case 'knowledge.graphEnabled':
        knowledgeGraphEnabled.value = value as boolean
        break
      case 'knowledge.graphModel':
        knowledgeGraphModel.value = value as string
        break
    }
  }

  /** 运行时效果：字体缩放（经 preload 的 webFrame.setZoomFactor 封装，默认 17 → 1.0；语言 i18n 同步 P2 接入） */
  function applyRuntimeEffects(): void {
    window.api.setZoomFactor(fontSize.value / DEFAULT_FONT_SIZE)
    applyThemeToDom()
  }

  /** 运行时效果：主题根节点标记 + localStorage 启动缓存 */
  function applyThemeToDom(): void {
    const next = theme.value === 'dark' ? 'dark' : 'light'
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = next
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('ke-work-theme', next)
    }
  }

  /** 从主进程加载全部设置（App 挂载后调用；失败保留首帧默认值） */
  async function load(): Promise<void> {
    const result = await window.api.getAllSettings()
    if (!result.success || !result.data) {
      console.warn('[settings] load failed:', result.error)
      return
    }
    const { settings, meta: snapshotMeta } = result.data
    for (const [key, value] of Object.entries(settings)) {
      applyToField(key, value)
    }
    meta.value = snapshotMeta
    loaded.value = true
    applyRuntimeEffects()
  }

  /** 写入待防抖队列（key 级：同一 key 连续写只落最后值） */
  const pendingWrites = new Map<string, unknown>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function flushWrites(): Promise<void> {
    const writes = [...pendingWrites.entries()]
    pendingWrites.clear()
    for (const [key, value] of writes) {
      const result = await window.api.setSetting(key, value)
      if (!result.success) {
        console.warn(`[settings] set ${key} failed:`, result.error)
        await load() // 失败回滚：以主进程为准重新拉取
        return
      }
    }
  }

  /**
   * 修改设置：乐观更新本地 + 运行时效果 → 300ms 防抖合并 → IPC 持久化
   * @throws 主进程校验失败时抛错（调用方展示）
   */
  async function set(key: SettingsKey, value: unknown): Promise<void> {
    applyToField(key, value)
    pendingWrites.set(key, value)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void flushWrites()
    }, 300)
    applyRuntimeEffects()
  }

  /** 切换主题：乐观更新 -> 持久化；失败由 set 内部 load() 回滚 */
  async function setTheme(next: ThemeName): Promise<void> {
    await set('ui.theme', next)
  }

  /** 刷新 ~/.ke-work 存储统计（打开设置页时调用） */
  async function refreshStorageStats(): Promise<void> {
    const result = await window.api.getStorageStats()
    if (result.success && result.data) {
      storageStats.value = result.data
    }
  }

  /**
   * 批量保存（「知识库设置」页「保存设置」按钮）：
   * 乐观更新 → 逐项立即 IPC 写入（不走防抖队列，便于按成败反馈）；任一项失败即回滚重载。
   * @returns 是否全部写入成功
   */
  async function saveMany(entries: Array<[SettingsKey, unknown]>): Promise<boolean> {
    for (const [key, value] of entries) {
      applyToField(key, value)
    }
    for (const [key, value] of entries) {
      const result = await window.api.setSetting(key, value)
      if (!result.success) {
        console.warn(`[settings] save ${key} failed:`, result.error)
        await load() // 失败回滚：以主进程为准重新拉取
        return false
      }
    }
    applyRuntimeEffects()
    return true
  }

  /** 知识库目录选择对话框（不迁移旧文件；非空则保存并同步 meta） */
  async function changeKnowledgeDir(): Promise<void> {
    const result = await window.api.selectKnowledgeDir()
    if (!result.success) throw new Error(result.error ?? '选择目录失败')
    if (result.data) {
      knowledgeDirectory.value = result.data
      if (meta.value) meta.value.defaultKnowledgeDir = result.data
    }
  }

  /** 系统目录选择对话框更改默认工作空间路径（非空则保存并同步 meta） */
  async function changeWorkspaceDir(): Promise<void> {
    const result = await window.api.selectDefaultWorkspaceDir()
    if (!result.success) throw new Error(result.error ?? '选择目录失败')
    if (result.data) {
      defaultWorkspaceDir.value = result.data
      if (meta.value) meta.value.defaultWorkspaceDir = result.data
      await useWorkspaceStore().load()
    }
  }

  return {
    language,
    fontSize,
    theme,
    skillAutoUpdate,
    pluginAutoUpdate,
    safeSkillInstall,
    remoteLock,
    proxyMode,
    proxyUrl,
    defaultWorkspaceDir,
    experienceImprovement,
    clientNotifications,
    notificationSound,
    runtimeEnabled,
    runtimePythonEnabled,
    runtimeNodeEnabled,
    runtimeGitEnabled,
    knowledgeDirectory,
    knowledgeMaxUploadSize,
    knowledgeUploadTimeout,
    knowledgeMaxFilesPerBatch,
    knowledgeChunkStrategy,
    knowledgeChunkSize,
    knowledgeChunkOverlap,
    knowledgeVectorDimensions,
    knowledgeEmbeddingModel,
    knowledgeSparseRetrieval,
    knowledgeBm25K1,
    knowledgeBm25B,
    knowledgeHybridWeight,
    knowledgeRerankEnabled,
    knowledgeRerankModel,
    knowledgeTopK,
    knowledgeGraphEnabled,
    knowledgeGraphModel,
    meta,
    storageStats,
    loaded,
    load,
    set,
    setTheme,
    saveMany,
    refreshStorageStats,
    changeWorkspaceDir,
    changeKnowledgeDir
  }
})
