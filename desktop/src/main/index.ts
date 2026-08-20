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
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { invokeSendMessage, toLangChainMessages, buildRegenerateInput } from './agent/service'
import { expandFileParts, normalizeMessageInput } from './agent/file-parts'
import type { MessagePart } from '../preload/index.d'
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
import { ConversationStore } from './agent/ConversationStore'
import { registerConversationHandlers } from './ipc/conversation-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerModeHandlers } from './ipc/mode-handlers'
import { WorkspaceService } from './workspace/WorkspaceService'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers'
import { MIGRATIONS_DIR } from './database/local/SqlMigrationRunner'
import { SettingsStore } from './settings/SettingsStore'
import { SettingsService, type ProxyMode, type ThemeName } from './settings/SettingsService'
import { registerConfigHandlers } from './ipc/config-handlers'
import { registerModelHandlers } from './ipc/model-handlers'
import { registerSkillSyncHandlers } from './ipc/skill-sync-handlers'
import { registerOAuth2Handlers } from './ipc/oauth2-handlers'
import { ModelService } from './model/ModelService'
import { LastLaunchStore } from './state/LastLaunchStore'
import { WorkspaceStateStore } from './state/WorkspaceStateStore'
import { BrowserViewManager, BROWSER_PARTITION } from './browser/BrowserViewManager'
import { WorkspacePreviewServer } from './browser/WorkspacePreviewServer'
import { registerBrowserHandlers } from './browser/browser-handlers'
import { SkillSyncService } from './skills/SkillSyncService'
import { OAuth2ClientService } from './oauth2/OAuth2ClientService'

import icon from '../../resources/icon.png?asset'

import 'dotenv/config'

// 测试/多实例隔离：允许通过环境变量覆盖 Electron 用户数据目录（localStorage 等）
if (process.env.KE_WORK_USER_DATA) {
  app.setPath('userData', process.env.KE_WORK_USER_DATA)
}

// 取消控制器映射（按窗口 ID）
const abortControllers = new Map<number, AbortController>()
const browserManagers = new Map<number, BrowserViewManager>()
let browserPreviewServer: WorkspacePreviewServer | null = null

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

  // ── 初始化自定义模型服务（机器级配置；providers.json 首启种子写入，用户可手改）──
  const modelService = new ModelService(dataDir.getBaseDir())

  // ── 初始化智能体（AgentManager）──
  // checkpoint（短期记忆）与 store（长期记忆）与业务表共用 ke-work.db（SqliteSaver/SqliteStore 自建表）
  const appDbPath = join(dataDir.getBaseDir(), 'ke-work.db')
  const agentManager = new AgentManager(
    dataDir.getDir('workspace'),
    appDbPath,
    appDbPath,
    modelService
  )
  agentManager.init(mode).catch((err) => console.error('[main] agent init failed:', err))

  const oauth2Client = new OAuth2ClientService({
    secureStorage,
    openExternal: (url) =>
      process.env.WORKMATE_OAUTH_INTERNAL_BROWSER === '1'
        ? openOAuthWindow(url)
        : shell.openExternal(url),
    apiBaseUrl: process.env.WORKMATE_WEB_API_BASE_URL ?? '',
    clientId: process.env.WORKMATE_OAUTH_CLIENT_ID ?? 'ke-work-desktop'
  })
  registerOAuth2Handlers(ipcMain, {
    authService,
    oauth2Client,
    session,
    secureStorage,
    agentManager
  })

  const skillSyncService = new SkillSyncService({
    secureStorage,
    openExternal: (url) =>
      process.env.WORKMATE_OAUTH_INTERNAL_BROWSER === '1'
        ? openOAuthWindow(url)
        : shell.openExternal(url),
    apiBaseUrl: process.env.WORKMATE_WEB_API_BASE_URL ?? '',
    clientId: process.env.WORKMATE_OAUTH_CLIENT_ID ?? 'ke-work-desktop'
  })
  registerSkillSyncHandlers(ipcMain, { skillSyncService, session })

  const cleanupBrowserOnLogout = (): void => {
    for (const manager of browserManagers.values()) {
      manager.resetForLogout()
    }
    void browserPreviewServer?.revokeAll()
    const localUserId = session.getCurrentUserId()
    if (localUserId) {
      void skillSyncService.disconnect(localUserId)
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

  const settingsStore = new SettingsStore(dataDir.getBaseDir())
  // eslint-disable-next-line prefer-const
  let workspaceService: WorkspaceService
  const applyTheme = (theme: ThemeName): void => {
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light'
  }
  const settingsService = new SettingsService(settingsStore, dataDir.getBaseDir(), {
    applyTheme,
    applyProxy: applyProxy as (mode: ProxyMode, url: string) => Promise<void>,
    setLockScreen,
    selectDir,
    openPath,
    onWorkspaceBaseDirChange: (dir) => workspaceService.setBaseDir(dir)
  })
  const initialSettings = settingsService.getAll()

  // ── 工作空间服务（按登录用户隔离；目录创建/校验集中在主进程）──
  // 工作空间目录基址默认用户家目录 KeWork/（与 ~/.ke-work 应用数据目录不同）；可由系统设置更改
  workspaceService = new WorkspaceService(
    dataSourceFactory.createWorkspaceRepository(),
    initialSettings.meta.workspaceBaseDir,
    { selectDir, openPath }
  )
  registerWorkspaceHandlers(ipcMain, { workspaceService, conversationStore, session })
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
      // 自定义模型 id（渲染层不可信：经 getCredential 校验归属，伪造/已删除则忽略回退默认模型）
      const customModelId = typeof optsObj.customModelId === 'string' ? optsObj.customModelId : undefined

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
          conversationStore.getMessages(userId, conversationId)
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

        await invokeSendMessage(
          messages,
          win,
          agent,
          {
            thread_id: conversationStore.buildThreadId(userId, conversationId),
            user_id: userId,
            workspace_dir: ws?.dir,
            workspace: ws,
            // 自定义模型：仅当记录存在时生效（校验防伪造），否则走默认模型
            ...(customModelId && modelService.getCredential(customModelId)
              ? { modelOverride: customModelId }
              : {})
          },
          controller.signal
        )
        // 对话流完成后异步生成 AI 总结标题（不阻塞响应；失败通过 title-error 事件提示）
        void generateConversationTitle(
          userId,
          conversationId,
          win,
          modelService,
          customModelId
        )
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

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
