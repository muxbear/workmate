import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useWorkspaceStore } from './workspace'
import type { KnowledgeOverrides } from '../../../preload/index.d'

/** 系统设置存储 key（与主进程 settings/schema.ts 对齐；嵌套路径扁平化） */
export type SettingsKey =
  | 'ui.language'
  | 'ui.fontSize'
  | 'ui.theme'
  | 'ui.systemName'
  | 'ui.brandLogo'
  | 'skills.autoUpdate'
  | 'skills.safeInstall'
  | 'lockScreen.remoteLock'
  | 'network.proxyMode'
  | 'network.proxyUrl'
  | 'workspace.defaultWorkspaceDir'
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

/** 系统名称默认值（与主进程 schema 的 DEFAULT_SYSTEM_NAME 对齐） */
export const DEFAULT_SYSTEM_NAME = 'Ke-Work'
/** 窗口标题后缀（与主进程 index.ts 的 WINDOW_TITLE_SUFFIX 对齐） */
const WINDOW_TITLE_SUFFIX = '桌面'

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
  // ── 系统标识（「系统设置 → 系统标识」）──
  const systemName = ref(DEFAULT_SYSTEM_NAME)
  /** 自定义 LOGO 文件名（空 = 使用内置默认 LOGO；仅作展示与判重） */
  const brandLogoFileName = ref('')
  /** 自定义 LOGO 的 data URL（空 = 使用内置默认 LOGO） */
  const brandLogoDataUrl = ref('')
  const skillAutoUpdate = ref(true)
  const safeSkillInstall = ref(false)
  const remoteLock = ref(false)
  const proxyMode = ref<ProxyMode>('direct')
  const proxyUrl = ref('')
  const defaultWorkspaceDir = ref('')
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

  /**
   * 知识库 17 项全局值（短 key 形态，字段与「按库覆盖」一一对应；不含存放目录）
   * 「知识库设置」页表单回填与按知识库设置弹窗的「跟随全局」都读它 —— 单一来源，
   * 因此全局值一变，所有未覆盖该项的知识库会自动跟随。
   */
  const knowledgeGlobalValues = computed<KnowledgeOverrides>(() => ({
    maxUploadSize: knowledgeMaxUploadSize.value,
    uploadTimeout: knowledgeUploadTimeout.value,
    maxFilesPerBatch: knowledgeMaxFilesPerBatch.value,
    chunkStrategy: knowledgeChunkStrategy.value,
    chunkSize: knowledgeChunkSize.value,
    chunkOverlap: knowledgeChunkOverlap.value,
    vectorDimensions: knowledgeVectorDimensions.value,
    embeddingModel: knowledgeEmbeddingModel.value,
    sparseRetrieval: knowledgeSparseRetrieval.value,
    bm25K1: knowledgeBm25K1.value,
    bm25B: knowledgeBm25B.value,
    hybridWeight: knowledgeHybridWeight.value,
    rerankEnabled: knowledgeRerankEnabled.value,
    rerankModel: knowledgeRerankModel.value,
    topK: knowledgeTopK.value,
    graphEnabled: knowledgeGraphEnabled.value,
    graphModel: knowledgeGraphModel.value
  }))

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
      case 'ui.systemName':
        systemName.value = typeof value === 'string' && value.trim() ? value : DEFAULT_SYSTEM_NAME
        break
      case 'ui.brandLogo':
        brandLogoFileName.value = (value as string) ?? ''
        break
      case 'skills.autoUpdate':
        skillAutoUpdate.value = value as boolean
        break
      case 'skills.safeInstall':
        safeSkillInstall.value = value as boolean
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

  /** 运行时效果：字体缩放（默认 17 → 1.0）+ 主题根节点 + 窗口标题（系统名称） */
  function applyRuntimeEffects(): void {
    window.api.setZoomFactor(fontSize.value / DEFAULT_FONT_SIZE)
    applyThemeToDom()
    applySystemNameToTitle()
  }

  /** 窗口标题跟随系统名称（Electron 以页面标题为准，主进程另有一份兜底设置） */
  function applySystemNameToTitle(): void {
    if (typeof document === 'undefined') return
    const name = systemName.value.trim() || DEFAULT_SYSTEM_NAME
    document.title = name + WINDOW_TITLE_SUFFIX
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
    await loadBrandLogo()
    applyRuntimeEffects()
  }

  /** 拉取系统 LOGO（主进程读文件转 data URL；未自定义时为空串，UI 回退内置默认 LOGO） */
  async function loadBrandLogo(): Promise<void> {
    const result = await window.api.getBrandLogo()
    if (!result.success || !result.data) {
      console.warn('[settings] load brand logo failed:', result.error)
      return
    }
    brandLogoFileName.value = result.data.fileName
    brandLogoDataUrl.value = result.data.dataUrl
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

  /** 是否已自定义 LOGO（UI 据此决定是否显示「恢复默认」） */
  const hasCustomLogo = computed(() => !!brandLogoDataUrl.value)

  /**
   * 上传系统 LOGO（「系统设置 → 系统标识」）。
   * 渲染层只做快速前置校验，主进程按魔数复检类型与体积后落盘，并回填新快照。
   * @throws 主进程校验失败时抛错（调用方展示错误文案）
   */
  async function uploadBrandLogo(file: File): Promise<void> {
    const bytes = await file.arrayBuffer()
    const result = await window.api.uploadBrandLogo({ name: file.name, bytes })
    if (!result.success || !result.data) {
      throw new Error(result.error ?? 'LOGO 上传失败')
    }
    brandLogoFileName.value = result.data.fileName
    brandLogoDataUrl.value = result.data.dataUrl
  }

  /** 恢复内置默认 LOGO（主进程删除自定义文件并清空设置） */
  async function resetBrandLogo(): Promise<void> {
    const result = await window.api.resetBrandLogo()
    if (!result.success || !result.data) {
      throw new Error(result.error ?? '恢复默认 LOGO 失败')
    }
    brandLogoFileName.value = ''
    brandLogoDataUrl.value = ''
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
    systemName,
    brandLogoFileName,
    brandLogoDataUrl,
    hasCustomLogo,
    skillAutoUpdate,
    safeSkillInstall,
    remoteLock,
    proxyMode,
    proxyUrl,
    defaultWorkspaceDir,
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
    knowledgeGlobalValues,
    meta,
    storageStats,
    loaded,
    load,
    set,
    setTheme,
    uploadBrandLogo,
    resetBrandLogo,
    saveMany,
    refreshStorageStats,
    changeWorkspaceDir,
    changeKnowledgeDir
  }
})
