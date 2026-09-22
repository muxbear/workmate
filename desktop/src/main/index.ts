import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session as electronSession,
  powerSaveBlocker,
  nativeTheme,
  Notification,
  powerMonitor,
  net,
  protocol,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { invokeSendMessage, toLangChainMessages, buildRegenerateInput } from './agent/service'
import { expandFileParts, normalizeMessageInput } from './agent/file-parts'
import type { MessagePart, DesktopExpert } from '../preload/index.d'
import { summarizeTitle } from './agent/title-service'
import { polishText, POLISH_MAX_TEXT_CHARS } from './agent/polish-service'
import { HumanMessage } from '@langchain/core/messages'
import { detectOS } from './platform'
import { getDataDirectory, initDataDirectory, migrateLegacyConfigFiles } from './data-dir'
import { WorkModeStore } from './mode/work-mode'
import { DataSourceFactory } from './database/DataSourceFactory'
import { AuthService } from './services/AuthService'
import { SessionService } from './services/SessionService'
import { ElectronSafeStorage } from './security/secure-storage'
import { registerAuthHandlers } from './ipc/auth-handlers'
import { AgentManager } from './agent/AgentManager'
import { normalizeBackendKind } from './agent/AgentBuilder'
import { ConversationStore } from './agent/ConversationStore'
import { RemoteImageService, registerRemoteImageScheme } from './images/RemoteImageService'
import { registerRemoteImageHandlers } from './ipc/image-handlers'
import { registerConversationHandlers } from './ipc/conversation-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerModeHandlers } from './ipc/mode-handlers'
import { WorkspaceService } from './workspace/WorkspaceService'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { MIGRATIONS_DIR } from './database/local/SqlMigrationRunner'
import { SettingsStore } from './settings/SettingsStore'
import { SettingsService, type ProxyMode, type ThemeName } from './settings/SettingsService'
import { BrandLogoService } from './settings/BrandLogoService'
import { DEFAULT_SYSTEM_NAME } from './settings/schema'
import { registerConfigHandlers } from './ipc/config-handlers'
import { KnowledgeSettingsStore } from './knowledge/KnowledgeSettingsStore'
import { KnowledgeSettingsService } from './knowledge/KnowledgeSettingsService'
import { registerKnowledgeHandlers } from './ipc/knowledge-handlers'
import { AutomationRepository } from './automation/AutomationRepository'
import { AutomationRunRepository } from './automation/AutomationRunRepository'
import { AutomationService } from './automation/AutomationService'
import { AuditLogRepository } from './automation/AuditLogRepository'
import { registerAutomationHandlers } from './ipc/automation-handlers'
import { AutomationRunner } from './automation/AutomationRunner'
import { AutomationScheduler } from './automation/AutomationScheduler'
import { KnowledgeStore } from './knowledge/KnowledgeStore'
import { KnowledgeFileService } from './knowledge/KnowledgeFileService'
import { KnowledgeService } from './knowledge/KnowledgeService'
import { registerModelHandlers } from './ipc/model-handlers'
import { registerSkillSyncHandlers } from './ipc/skill-sync-handlers'
import { registerExpertSyncHandlers } from './ipc/expert-sync-handlers'
import { registerModelSyncHandlers } from './ipc/model-sync-handlers'
import { registerOAuth2Handlers } from './ipc/oauth2-handlers'
import { BinaryManager } from './runtime/BinaryManager'
import { registerRuntimeHandlers } from './ipc/runtime-handlers'
import { ModelService } from './model/ModelService'
import { LastLaunchStore } from './state/LastLaunchStore'
import { WorkspaceStateStore } from './state/WorkspaceStateStore'
import { BrowserViewManager, BROWSER_PARTITION } from './browser/BrowserViewManager'
import { WorkspacePreviewServer } from './browser/WorkspacePreviewServer'
import { registerBrowserHandlers } from './browser/browser-handlers'
import { SkillSyncService } from './skills/SkillSyncService'
import { SkillJsonStore } from './skills/SkillJsonStore'
import { SkillFileStore } from './skills/SkillFileStore'
import { SkillInstallService } from './skills/SkillInstallService'
import { ExpertSyncService } from './experts/ExpertSyncService'
import { ModelSyncService } from './models/ModelSyncService'
import { OAuth2ClientService } from './oauth2/OAuth2ClientService'
import { OAuth2AuthorizationProvider } from './oauth2/OAuth2AuthorizationProvider'

import icon from '../../resources/icon.png?asset'

import 'dotenv/config'

// 远程图片缓存协议：特权 scheme 必须在 app ready 之前注册（渲染层 img-src 白名单含 ke-img:）
registerRemoteImageScheme(protocol)

// 测试/多实例隔离：允许通过环境变量覆盖 Electron 用户数据目录（localStorage 等）
if (process.env.KE_WORK_USER_DATA) {
  app.setPath('userData', process.env.KE_WORK_USER_DATA)
}

// 取消控制器映射（按窗口 ID）
const abortControllers = new Map<number, AbortController>()
const browserManagers = new Map<number, BrowserViewManager>()
let browserPreviewServer: WorkspacePreviewServer | null = null

/** 窗口标题后缀（与渲染层 document.title 拼接规则保持一致） */
const WINDOW_TITLE_SUFFIX = '桌面'
/**
 * 跟随系统名称变化的窗口集合（仅主窗口）。
 * OAuth 授权窗等固定标题窗口不登记，避免改名把它们一并覆盖。
 */
const brandWindows = new Set<BrowserWindow>()

/** 取消所有正在执行中的 agent 任务（登出时停止全部任务/后台会话） */
function cancelAllAgents(): void {
  for (const controller of abortControllers.values()) {
    controller.abort()
  }
  abortControllers.clear()
}

function getThemeBackground(theme: unknown): string {
  return theme === 'dark' ? '#0f172a' : '#ffffff'
}

function createWindow(backgroundColor = '#ffffff'): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    backgroundColor,
    autoHideMenuBar: true,
    fullscreenable: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.maximize()
  brandWindows.add(mainWindow)
  mainWindow.on('closed', () => brandWindows.delete(mainWindow))

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (browserPreviewServer) {
    const manager = new BrowserViewManager(mainWindow, browserPreviewServer)
    browserManagers.set(mainWindow.id, manager)
    mainWindow.on('closed', () => {
      browserManagers.delete(mainWindow.id)
      manager.destroy()
    })
  }

  return mainWindow
}

/**
 * 打开 OAuth2 授权窗口（内嵌 BrowserWindow）。
 *
 * 默认流程用 shell.openExternal 打开系统浏览器（RFC 8252 推荐）；
 * 设置 WORKMATE_OAUTH_INTERNAL_BROWSER=1 时改为应用内授权窗口，
 * 供自动化测试/无头环境使用。授权完成回跳 loopback 回调后自动关闭。
 */
async function openOAuthWindow(url: string): Promise<void> {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    show: true,
    autoHideMenuBar: true,
    title: 'WorkMate Web 登录',
    webPreferences: {
      sandbox: false
    }
  })

  const closeOnCallback = (targetUrl: string): void => {
    try {
      const u = new URL(targetUrl)
      if (
        u.protocol === 'http:' &&
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
        u.pathname === '/callback'
      ) {
        win.close()
      }
    } catch {
      // 忽略无法解析的 URL
    }
  }
  // 只在导航完成后关闭：will-navigate 阶段关闭会取消回跳请求，
  // 导致 loopback 回调服务器收不到授权码
  win.webContents.on('did-redirect-navigation', (_event, url) => closeOnCallback(url))
  win.webContents.on('did-navigate', (_event, targetUrl) => closeOnCallback(targetUrl))
  await win.loadURL(url)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // 检测操作系统类型并初始化数据目录
  detectOS()
  initDataDirectory()

  // 旧布局 config/ → 顶层一次性迁移（对齐 WorkBuddy 顶层平铺；须在 WorkModeStore/SessionService 构造前）
  const dataDir = getDataDirectory()
  migrateLegacyConfigFiles(dataDir.getBaseDir())

  // 系统设置存储：提前构造，供 OAuth 回调页等主进程侧品牌展示读取系统名称
  const settingsStore = new SettingsStore(dataDir.getBaseDir())
  /** 当前系统名称（主进程侧读取；设置缺失/异常时回退默认值） */
  const readSystemName = (): string => {
    const name = settingsStore.get('ui.systemName')
    return typeof name === 'string' && name.trim() ? name : DEFAULT_SYSTEM_NAME
  }

  // ── 远程图片缓存服务（ke-img:// 协议 + 落盘缓存；解决外链图片 CSP 拦截与 URL 过期）──
  const remoteImageService = new RemoteImageService(
    join(dataDir.getDir('cache'), 'remote-images'),
    (url, init) => net.fetch(url, init)
  )
  remoteImageService.registerProtocol(protocol)

  // ── 初始化工作模式 ──
  const workModeStore = new WorkModeStore(dataDir.getBaseDir())
  const mode = workModeStore.getMode()

  // ── 初始化数据源工厂 ──
  const dataSourceFactory = DataSourceFactory.getInstance()
  dataSourceFactory.configure({
    localDbPath: join(dataDir.getBaseDir(), 'ke-work.db'),
    localMigrationsDir: join(dataDir.getBaseDir(), MIGRATIONS_DIR),
    cloudBaseUrl: process.env.CLOUD_API_BASE_URL ?? ''
  })
  dataSourceFactory.setMode(mode)

  // ── 初始化安全存储与 JWT 密钥 ──
  const secureStorage = new ElectronSafeStorage(
    join(dataDir.getBaseDir(), 'secrets.bin'),
    safeStorage
  )
  let jwtSecret = secureStorage.get('jwt-secret')
  if (!jwtSecret) {
    jwtSecret = randomBytes(32).toString('hex')
    secureStorage.set('jwt-secret', jwtSecret)
  }

  // ── 初始化认证服务与会话 ──
  const authService = new AuthService({
    repository: dataSourceFactory.createAuthRepository(),
    localAuthRepository: dataSourceFactory.createLocalAuthRepository(),
    jwtSecret,
    secureStorage
  })
  const session = new SessionService(dataDir.getBaseDir())
  browserPreviewServer = new WorkspacePreviewServer()

  // ── 注册远程图片 IPC（Markdown 图片外链 → 本地 ke-img:// 缓存地址）──
  registerRemoteImageHandlers(ipcMain, {
    remoteImageService,
    requireUserId: () => session.requireUserId()
  })

  // ── 初始化自定义模型服务（机器级配置；providers.json 首启种子写入，用户可手改）──
  const modelService = new ModelService(dataDir.getBaseDir())

  // 内置运行时管理器（安全中心「内置运行时」与技能脚本运行环境共用同一注册表）
  const binaryManager = new BinaryManager(dataDir.getDir('binaries'), settingsStore)
  binaryManager.init()

  // ── 初始化智能体（AgentManager）──
  // checkpoint（短期记忆）与 store（长期记忆）与业务表共用 ke-work.db（SqliteSaver/SqliteStore 自建表）
  const appDbPath = join(dataDir.getBaseDir(), 'ke-work.db')
  /** 技能安装服务引用（AgentManager 的技能 id 解析依赖它，创建顺序在后） */
  let skillInstallServiceRef: SkillInstallService | null = null
  const agentManager = new AgentManager(
    dataDir.getDir('workspace'),
    appDbPath,
    appDbPath,
    modelService,
    {
      skillsDir: dataDir.getDir('skills'),
      resolveSkillDirs: async (ids) =>
        skillInstallServiceRef ? await skillInstallServiceRef.resolveDirNames(ids) : []
    }
  )
  agentManager.init(mode).catch((err) => console.error('[main] agent init failed:', err))

  const oauth2Client = new OAuth2ClientService({
    secureStorage,
    openExternal: (url) =>
      process.env.WORKMATE_OAUTH_INTERNAL_BROWSER === '1'
        ? openOAuthWindow(url)
        : shell.openExternal(url),
    apiBaseUrl: process.env.WORKMATE_WEB_API_BASE_URL ?? '',
    clientId: process.env.WORKMATE_OAUTH_CLIENT_ID ?? 'ke-work-desktop',
    // 授权回跳页展示当前系统名称（authorize 调用时读取，此时设置已加载）
    getSystemName: readSystemName
  })
  // 统一授权提供者：登录 / 专家 / 技能 / 模型共用一份会话 token（一次授权，处处复用）
  const authorization = new OAuth2AuthorizationProvider({
    oauth2Client,
    secureStorage
  })
  registerOAuth2Handlers(ipcMain, {
    authService,
    oauth2Client,
    authorization,
    session,
    secureStorage,
    agentManager
  })

  const webApiBaseUrl = process.env.WORKMATE_WEB_API_BASE_URL ?? ''
  const skillsDir = dataDir.getDir('skills')
  const skillStore = new SkillJsonStore(skillsDir)
  const skillFileStore = new SkillFileStore(skillsDir)
  const skillSyncService = new SkillSyncService({
    authorization,
    store: skillStore,
    fileStore: skillFileStore,
    apiBaseUrl: webApiBaseUrl
  })
  const skillInstallService = new SkillInstallService({
    store: skillStore,
    fileStore: skillFileStore,
    binaryManager,
    agentManager
  })
  skillInstallServiceRef = skillInstallService
  registerSkillSyncHandlers(ipcMain, { skillSyncService, skillInstallService, session })
  // 启动即恢复已安装技能到主智能体（skills.json 为事实源）
  void skillInstallService
    .restoreInstalled()
    .catch((err) => console.error('[main] restore installed skills failed:', err))

  const expertSyncService = new ExpertSyncService({
    authorization,
    expertsDir: join(dataDir.getBaseDir(), 'experts'),
    apiBaseUrl: webApiBaseUrl
  })
  registerExpertSyncHandlers(ipcMain, { expertSyncService, session })

  const modelSyncService = new ModelSyncService({
    authorization,
    modelService,
    apiBaseUrl: webApiBaseUrl
  })
  registerModelSyncHandlers(ipcMain, { modelSyncService, session })

  const cleanupBrowserOnLogout = (): void => {
    for (const manager of browserManagers.values()) {
      manager.resetForLogout()
    }
    void browserPreviewServer?.revokeAll()
    const localUserId = session.getCurrentUserId()
    if (localUserId) {
      void skillSyncService.disconnect(localUserId)
      void expertSyncService.disconnect(localUserId)
      void modelSyncService.disconnect(localUserId)
    }
  }

  // ── 注册认证 IPC ──
  registerAuthHandlers(ipcMain, {
    authService,
    dataSourceFactory,
    session,
    cancelAllAgents,
    onLogout: cleanupBrowserOnLogout,
    oauth2Client,
    secureStorage
  })

  // ── 注册会话 IPC（基于 LangGraph checkpointer 的会话读写；自定义标题落本地业务表）──
  const conversationStore = new ConversationStore(
    () => agentManager.getCheckpointer(),
    () => dataSourceFactory.getLocalDb()
  )
  registerConversationHandlers(ipcMain, { conversationStore, session })

  // ── 注册文件附件 IPC（选中文件即时校验：存在性 + 类型分类 + 大小）──
  registerFileHandlers(ipcMain, { requireUserId: () => session.requireUserId() })

  // ── 系统设置服务（代理/锁屏/目录依赖在此注入；机器级配置，不依赖登录态）──
  const applyProxy = async (mode: string, url: string): Promise<void> => {
    const browserSession = electronSession.fromPartition(BROWSER_PARTITION)
    if (mode === 'direct') {
      await electronSession.defaultSession.setProxy({ mode: 'direct' })
      await browserSession.setProxy({ mode: 'direct' })
    } else if (mode === 'system') {
      await electronSession.defaultSession.setProxy({ mode: 'system' })
      await browserSession.setProxy({ mode: 'system' })
    } else {
      await electronSession.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: url })
      await browserSession.setProxy({ mode: 'fixed_servers', proxyRules: url })
    }
    console.log(`[settings] proxy applied: mode=${mode}`)
  }
  let lockScreenEnabled = false
  let lockBlockerId: number | null = null
  const setLockScreen = (enabled: boolean): void => {
    if (enabled === lockScreenEnabled) return
    lockScreenEnabled = enabled
    if (enabled) {
      lockBlockerId ??= powerSaveBlocker.start('prevent-display-sleep')
      console.log('[settings] lock-screen keep-awake enabled')
    } else {
      if (lockBlockerId != null) {
        powerSaveBlocker.stop(lockBlockerId)
        lockBlockerId = null
      }
      console.log('[settings] lock-screen keep-awake disabled')
    }
  }
  const selectDir = async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }
  const openPath = async (p: string): Promise<void> => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
  }
  /** 打包下载的「另存为」：默认落在系统下载目录，用户取消返回 null */
  const chooseZipPath = async (defaultName: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      defaultPath: join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
  }
  /** 导出完成后在资源管理器中定位文件 */
  const revealFile = async (absPath: string): Promise<void> => {
    shell.showItemInFolder(absPath)
  }

  // eslint-disable-next-line prefer-const
  let workspaceService: WorkspaceService
  const applyTheme = (theme: ThemeName): void => {
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light'
  }
  const applySystemName = (name: string): void => {
    const title = name + WINDOW_TITLE_SUFFIX
    for (const win of brandWindows) {
      if (!win.isDestroyed()) win.setTitle(title)
    }
  }
  const brandLogoService = new BrandLogoService(dataDir.getBaseDir())
  const settingsService = new SettingsService(settingsStore, dataDir.getBaseDir(), {
    applyTheme,
    applySystemName,
    brandLogoService,
    applyProxy: applyProxy as (mode: ProxyMode, url: string) => Promise<void>,
    setLockScreen,
    selectDir,
    openPath,
    onDefaultWorkspaceDirChange: async (dir) => {
      await workspaceService.changeDefaultWorkspaceDir(dir)
    }
  })
  const initialSettings = settingsService.getAll()
  // LOGO 目录历史残留清理（保留当前设置引用的文件，避免多次替换后堆积）
  settingsService.pruneBrandLogos()

  // ── 工作空间服务（按登录用户隔离；目录创建/校验集中在主进程）──
  // 默认工作空间目录默认 ~/KeWork（与 ~/.ke-work 应用数据目录不同）；可由系统设置更改
  workspaceService = new WorkspaceService(
    dataSourceFactory.createWorkspaceRepository(),
    initialSettings.meta.defaultWorkspaceDir,
    {
      selectDir,
      openPath,
      onWorkspaceMigrated: (moves) => conversationStore.syncWorkspaceDirs(moves)
    }
  )
  registerWorkspaceHandlers(ipcMain, {
    workspaceService,
    conversationStore,
    session,
    chooseZipPath,
    revealFile
  })
  registerBrowserHandlers(ipcMain, {
    getBrowserManager: (event: IpcMainInvokeEvent): BrowserViewManager => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window found')
      const existing = browserManagers.get(win.id)
      if (existing) return existing
      const manager = new BrowserViewManager(win, browserPreviewServer!)
      browserManagers.set(win.id, manager)
      return manager
    },
    workspaceService,
    session
  })

  // ── 自定义模型 IPC（机器级，models.json 本地文件）──
  registerModelHandlers(ipcMain, { modelService })

  // ── 启动时应用设置（窗口创建前；顺序：工作空间基址 → 代理 → 锁屏）──
  void applyProxy(
    initialSettings.settings['network.proxyMode'] as string,
    initialSettings.settings['network.proxyUrl'] as string
  ).catch((err) => console.warn('[settings] apply proxy on startup failed:', err))
  applyTheme(initialSettings.settings['ui.theme'] as ThemeName)
  setLockScreen(initialSettings.settings['lockScreen.remoteLock'] === true)

  // ── 启动快照与工作区状态（对齐 WorkBuddy last-launch.json / workspace-state.json）──
  new LastLaunchStore(dataDir.getBaseDir()).setLaunch({
    version: app.getVersion(),
    build: '',
    timestamp: new Date().toISOString()
  })
  new WorkspaceStateStore(dataDir.getBaseDir())

  // ── 注册系统设置 IPC（机器级，不调 requireUserId）──
  registerConfigHandlers(ipcMain, { settingsService })

  // ── 知识库设置 IPC（用户级：按登录用户隔离，须 requireUserId，与 config:* 语义不同）──
  // 「知识库设置」页的全局值仍在 settings.json；这里只存每个知识库的稀疏覆盖项
  const knowledgeSettingsStore = new KnowledgeSettingsStore(dataDir.getDir('knowledge'))
  const knowledgeSettingsService = new KnowledgeSettingsService(knowledgeSettingsStore, {
    getGlobalSettings: () => settingsStore.getAll()
  })
  // 知识库索引库（独立 index.db，位置由「知识库设置 → 本地存储」决定）
  const knowledgeStore = new KnowledgeStore(() => settingsService.getKnowledgeDir())
  const knowledgeFileService = new KnowledgeFileService(knowledgeStore, {
    getDir: () => settingsService.getKnowledgeDir(),
    getLimits: () => ({
      maxUploadSizeMB: Number(settingsStore.get('knowledge.maxUploadSize')) || 100,
      maxFilesPerBatch: Number(settingsStore.get('knowledge.maxFilesPerBatch')) || 20,
      uploadTimeoutMinutes: Number(settingsStore.get('knowledge.uploadTimeout')) || 10
    })
  })
  const knowledgeService = new KnowledgeService(knowledgeStore, knowledgeFileService)
  registerKnowledgeHandlers(ipcMain, {
    knowledgeSettingsService,
    knowledgeService,
    session,
    // 打开文件夹：主进程执行，渲染层只传 ID 与库内相对路径
    openDir: async (dir) => {
      const error = await shell.openPath(dir)
      // openPath 失败时返回错误文案（成功为空串）；打日志便于排查环境问题
      if (error) console.warn('[knowledge] 打开文件夹失败:', dir, error)
      return error
    },
    showItemInFolder: (file) => {
      console.log('[knowledge] 定位文件:', file)
      shell.showItemInFolder(file)
    }
  })

  // ── 注册内置运行时管理 IPC（机器级，不调 requireUserId）──
  registerRuntimeHandlers(ipcMain, { binaryManager })

  // 打开默认工作目录（~/.ke-work/workspace；未绑定工作空间的会话使用）
  ipcMain.handle('workspace:open-default', async () => {
    try {
      const err = await shell.openPath(dataDir.getDir('workspace'))
      return err ? { success: false, error: err } : { success: true, data: null }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // ── 注册工作模式 IPC ──
  registerModeHandlers(ipcMain, {
    modeStore: workModeStore,
    dataSourceFactory,
    agentManager,
    authService,
    session
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('open-external', async (_, url: string) => {
    await shell.openExternal(url)
  })

  // 打开 Web 版首页（前往管理中心入口；地址可用 WORKMATE_WEB_FRONTEND_URL 覆盖）
  ipcMain.handle('web:open-home', async () => {
    const webFrontendUrl = process.env.WORKMATE_WEB_FRONTEND_URL ?? 'http://localhost:5173'
    await shell.openExternal(webFrontendUrl)
  })

  // 自动化：任务定义与运行记录（本地库，按用户隔离）
  const automationRepository = new AutomationRepository(dataSourceFactory.getLocalDb())
  const automationRunRepository = new AutomationRunRepository(dataSourceFactory.getLocalDb())
  const automationAuditRepository = new AuditLogRepository(dataSourceFactory.getLocalDb())
  const automationService = new AutomationService(automationRepository, automationRunRepository, {
    audit: automationAuditRepository
  })
  // 启动清理：悬挂运行标记为中断 + 清理过期运行记录
  automationService.onStartup()
  registerAutomationHandlers(ipcMain, { automationService, session })

  // 自动化执行器：独立 AgentManager，避免与交互式对话共享实例被 setExperts 重建
  const automationAgentManager = new AgentManager(
    dataDir.getDir('workspace'),
    appDbPath,
    appDbPath,
    modelService
  )
  void automationAgentManager.init(mode)
  const automationRunner = new AutomationRunner({
    tasks: automationRepository,
    runs: automationRunRepository,
    service: automationService,
    conversationStore,
    workspaceService,
    modelService,
    agentManager: automationAgentManager,
    resolveExperts: async () => (await expertSyncService.loadLocal())?.experts ?? [],
    broadcast: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
    },
    notify: (payload) => {
      try {
        if (!settingsStore.get('notification.clientNotifications')) return
        if (!Notification.isSupported()) return
        new Notification({
          title: '自动化任务：' + payload.title,
          body: payload.message,
          silent: !settingsStore.get('notification.sound')
        }).show()
      } catch (err) {
        console.warn('[automation] notification failed:', err)
      }
    }
  })
  const automationScheduler = new AutomationScheduler({
    service: automationService,
    runner: automationRunner
  })
  automationService.setRunHandler((task, trigger) => automationRunner.run(task, trigger))
  void automationScheduler.start()
  // 休眠唤醒后立即检查一次到期任务
  powerMonitor.on('resume', () => {
    void automationScheduler.handleResume()
  })
  app.on('before-quit', () => {
    automationScheduler.stop()
  })

  // Agent message handler
  ipcMain.handle(
    'agent:send',
    async (
      event,
      conversationId?: unknown,
      content?: unknown,
      workspaceId?: unknown,
      opts?: unknown
    ) => {
      console.log('[main] agent:send handler, conversationId:', conversationId)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        console.error('[main] No window found for event.sender')
        throw new Error('No window found')
      }
      if (typeof conversationId !== 'string' || !conversationId) {
        return { success: false, error: '参数错误' }
      }
      const optsObj =
        typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>) : {}
      const regenerate = optsObj.regenerate === true
      // AI 轮次序号（1 起）：渲染层传入，用于元信息/文档产物按轮持久化与 regenerate 清理
      const turnIndex =
        typeof optsObj.turnIndex === 'number' &&
        Number.isInteger(optsObj.turnIndex) &&
        optsObj.turnIndex > 0
          ? optsObj.turnIndex
          : undefined
      // 自定义模型 id（渲染层不可信：经 getCredential 校验归属，伪造/已删除则忽略回退默认模型）
      const customModelId =
        typeof optsObj.customModelId === 'string' ? optsObj.customModelId : undefined
      // 主智能体后端类型（渲染层不可信）：白名单校验，非法/缺省回退默认 shell 后端
      const backendKind = normalizeBackendKind(optsObj.backendKind)

      // 消息内容归一：字符串（regenerate 历史文本）→ 单文本段；数组 → 形状校验（主进程权威）
      // 校验失败/无有效内容返回错误对象（错误信息直达渲染层，避免 handle 拒绝丢失消息）
      let parts: MessagePart[]
      try {
        parts = normalizeMessageInput(content)
      } catch (err) {
        return { success: false, error: (err as Error).message || '参数错误' }
      }

      const controller = new AbortController()
      abortControllers.set(win.id, controller)

      try {
        // 会话历史（checkpoint 内）+ 本轮新消息；历史带 id，图内 reducer 按 id 去重
        const userId = session.requireUserId()
        const [agent, history] = await Promise.all([
          agentManager.ready(),
          conversationStore.getRawMessages(userId, conversationId)
        ])
        const messages = toLangChainMessages(history)
        if (regenerate) {
          // 重新生成：删除最后一条 user 之后的消息（RemoveMessage 命令），图继续生成新回复
          messages.push(...buildRegenerateInput(history))
        } else {
          // 文件附件由主进程展开为内容块（读取/校验/转换失败整体抛错，错误信息含文件名）
          const contentBlocks = await expandFileParts(parts)
          messages.push(new HumanMessage({ id: `msg-${randomUUID()}`, content: contentBlocks }))
        }

        // 工作空间解析（主进程权威）：会话已绑定 > 渲染层当前选择 > null（backend 兜底默认目录）
        // 已绑定会话忽略渲染层传入 id（绑定优先），防伪造与误切
        const bound = await conversationStore.getWorkspace(userId, conversationId)
        const ws =
          bound ??
          (typeof workspaceId === 'string' && workspaceId
            ? workspaceService.resolveWorkspace(workspaceId, userId)
            : null)

        // 会话→工作空间绑定落库（业务表显式存储；LangGraph checkpoint metadata 不可靠，会话列表据此分组）
        if (ws) {
          conversationStore.bindWorkspace(userId, conversationId, ws)
        }

        // 重新生成：先清理该轮起（含）的展示元信息/文档产物，避免旧回复残留
        if (regenerate && turnIndex !== undefined) {
          conversationStore.deleteTurnDataFrom(userId, conversationId, turnIndex)
        }

        await invokeSendMessage(
          messages,
          win,
          agent,
          {
            thread_id: conversationStore.buildThreadId(userId, conversationId),
            user_id: userId,
            workspace_dir: ws?.dir,
            workspace: ws,
            backendKind,
            // 自定义模型：仅当记录存在时生效（校验防伪造），否则走默认模型
            ...(customModelId && modelService.getCredential(customModelId)
              ? { modelOverride: customModelId }
              : {})
          },
          controller.signal,
          (artifacts) => {
            if (turnIndex === undefined) return
            try {
              conversationStore.saveTurnArtifacts(
                userId,
                conversationId,
                turnIndex,
                artifacts.map((artifact) => ({
                  name: artifact.name,
                  relPath: artifact.relPath,
                  ext: artifact.ext,
                  workspaceId: artifact.workspaceId ?? null
                }))
              )
            } catch (err) {
              console.error('[main] save turn artifacts failed:', err)
            }
          }
        )
        // 对话流完成后异步生成 AI 总结标题（不阻塞响应；失败通过 title-error 事件提示）
        void generateConversationTitle(userId, conversationId, win, modelService, customModelId)
        console.log('[main] invokeSendMessage completed, returning success')
        return { success: true }
      } catch (error) {
        console.error('[main] Error handling message:', error)
        return { success: false, error: (error as Error).message || 'Unknown error' }
      } finally {
        abortControllers.delete(win.id)
      }
    }
  )

  // 设置当前选中的专家为子智能体；调用方需等待完成后再发送消息
  ipcMain.handle('agent:set-experts', async (_event, experts: unknown) => {
    try {
      session.requireUserId()
      if (!Array.isArray(experts)) {
        return { success: false, error: '参数错误' }
      }
      await agentManager.setExperts(experts as DesktopExpert[])
      return { success: true, data: null }
    } catch (err) {
      console.error('[main] set experts failed:', err)
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message || '设置专家失败' }
    }
  })

  // AI 改写润色（登录态；单次 LLM 请求，非流式；入参校验 + 长度上限主进程权威）
  ipcMain.handle('agent:polish', async (_event, text: unknown) => {
    try {
      session.requireUserId()
      if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: '请输入要改写的内容' }
      }
      if (text.length > POLISH_MAX_TEXT_CHARS) {
        return { success: false, error: `改写内容过长（上限 ${POLISH_MAX_TEXT_CHARS} 字符）` }
      }
      const polished = await polishText(text)
      return { success: true, data: polished }
    } catch (err) {
      console.error('[main] agent:polish failed:', err)
      return { success: false, error: (err as Error).message || '改写失败' }
    }
  })

  // Agent cancel handler
  ipcMain.on('agent:cancel', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      const controller = abortControllers.get(win.id)
      controller?.abort()
    }
  })

  /**
   * 对话流结束后异步生成 AI 总结标题并推送更新事件（渲染层侧栏即时刷新）
   * 失败（模型未配置/LLM 不可用/超时）时推送 title-error 事件，会话标题保持派生标题（首条消息截断兜底）
   */
  async function generateConversationTitle(
    userId: string,
    conversationId: string,
    win: BrowserWindow,
    modelService: ModelService,
    customModelId?: string
  ): Promise<void> {
    try {
      const messages = await conversationStore.getMessages(userId, conversationId)
      if (messages.length === 0) return
      const title = await summarizeTitle(messages, modelService, customModelId)
      if (!title) return
      conversationStore.saveAutoTitle(userId, conversationId, title)
      win.webContents.send('conversation:title-updated', { conversationId, title })
    } catch (err) {
      console.error('[main] generate conversation title failed:', err)
      win.webContents.send('conversation:title-error', {
        conversationId,
        error: err instanceof Error ? err.message : '标题生成失败'
      })
    }
  }

  createWindow(getThemeBackground(initialSettings.settings['ui.theme']))
  // 窗口标题按系统名称初始化（渲染层加载后由 document.title 接管同一文案）
  applySystemName(readSystemName())

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      applySystemName(readSystemName())
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (browserPreviewServer) {
    void browserPreviewServer.stop()
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
