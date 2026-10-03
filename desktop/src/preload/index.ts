import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AgentDelegateEnd,
  AgentDelegateStart,
  AutomationTemplateSyncProgress,
  BrandLogoUploadPayload,
  DesktopExpert,
  ExpertSyncProgress,
  SkillInstallProgress,
  SkillSyncProgress
} from './index.d'

// Custom APIs for renderer
/** 问答事件订阅（4 个 ask-* 事件同一约定：返回取消订阅函数） */
function subscribeKnowledgeAskEvent(
  channel: string,
  callback: (payload: unknown) => void
): () => void {
  const listener = (_event: unknown, payload: unknown): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openWebHome: () => ipcRenderer.invoke('web:open-home'),
  sendAgentMessage(
    conversationId: string,
    parts: ({ type: 'text'; text: string } | { type: 'file'; path: string })[] | string,
    workspaceId?: string,
    opts?: {
      regenerate?: boolean
      model?: string
      customModelId?: string
      backendKind?: 'filesystem' | 'shell'
      turnIndex?: number
      createdAt?: number
    }
  ): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('agent:send', conversationId, parts, workspaceId, opts) as Promise<{
      success: boolean
      error?: string
    }>
  },
  cancelAgentMessage(): void {
    ipcRenderer.send('agent:cancel')
  },
  setExperts(experts: DesktopExpert[]) {
    return ipcRenderer.invoke('agent:set-experts', experts)
  },
  onAgentChunk(callback: (chunk: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, chunk: string): void => {
      callback(chunk)
    }
    ipcRenderer.on('agent:stream-chunk', handler)
    return () => ipcRenderer.removeListener('agent:stream-chunk', handler)
  },
  onAgentThinking(callback: (chunk: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, chunk: string): void => {
      callback(chunk)
    }
    ipcRenderer.on('agent:stream-thinking', handler)
    return () => ipcRenderer.removeListener('agent:stream-thinking', handler)
  },
  onAgentThinkingDone(callback: () => void): () => void {
    ipcRenderer.on('agent:stream-thinking-done', callback)
    return () => ipcRenderer.removeListener('agent:stream-thinking-done', callback)
  },
  onAgentDone(callback: () => void): () => void {
    ipcRenderer.on('agent:stream-done', callback)
    return () => ipcRenderer.removeListener('agent:stream-done', callback)
  },
  onAgentDelegateStart(callback: (data: AgentDelegateStart) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentDelegateStart): void => {
      callback(data)
    }
    ipcRenderer.on('agent:delegate-start', handler)
    return () => ipcRenderer.removeListener('agent:delegate-start', handler)
  },
  onAgentDelegateEnd(callback: (data: AgentDelegateEnd) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: AgentDelegateEnd): void => {
      callback(data)
    }
    ipcRenderer.on('agent:delegate-end', handler)
    return () => ipcRenderer.removeListener('agent:delegate-end', handler)
  },
  onAgentArtifactStart(
    callback: (meta: {
      artifactId: string
      name: string
      relPath: string
      workspaceId: string | null
      ext: string
      preview: string
    }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      meta: {
        artifactId: string
        name: string
        relPath: string
        workspaceId: string | null
        ext: string
        preview: string
      }
    ): void => {
      callback(meta)
    }
    ipcRenderer.on('agent:artifact-start', handler)
    return () => ipcRenderer.removeListener('agent:artifact-start', handler)
  },
  onAgentArtifactChunk(callback: (data: { artifactId: string; text: string }) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { artifactId: string; text: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('agent:artifact-chunk', handler)
    return () => ipcRenderer.removeListener('agent:artifact-chunk', handler)
  },
  onAgentArtifactEnd(callback: (data: { artifactId: string; ok: boolean }) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { artifactId: string; ok: boolean }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('agent:artifact-end', handler)
    return () => ipcRenderer.removeListener('agent:artifact-end', handler)
  },
  onAgentArtifactError(
    callback: (data: { artifactId: string; error: string }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { artifactId: string; error: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('agent:artifact-error', handler)
    return () => ipcRenderer.removeListener('agent:artifact-error', handler)
  },
  onConversationTitleUpdated(
    callback: (data: { conversationId: string; title: string }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; title: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('conversation:title-updated', handler)
    return () => ipcRenderer.removeListener('conversation:title-updated', handler)
  },
  onConversationTitleError(
    callback: (data: { conversationId: string; error: string }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; error: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('conversation:title-error', handler)
    return () => ipcRenderer.removeListener('conversation:title-error', handler)
  },
  // ── 文件附件 API ──
  inspectFile(path: string) {
    return ipcRenderer.invoke('file:inspect', path)
  },
  /** 获取文件选择器选中文件的绝对路径（Electron 39 已移除 File.path，须走 webUtils） */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  /** AI 改写润色输入文本（主进程调 LLM，非流式；data 为改写结果） */
  polishText(text: string) {
    return ipcRenderer.invoke('agent:polish', text) as Promise<{
      success: boolean
      error?: string
      data?: string
    }>
  },
  /** 将远程图片 URL 解析为本地 ke-img:// 缓存地址（主进程下载并落盘；data.url 为本地协议地址） */
  resolveRemoteImage(url: string) {
    return ipcRenderer.invoke('images:resolve', url) as Promise<{
      success: boolean
      error?: string
      data?: { url: string }
    }>
  },
  // ── 认证 API ──
  loginByPassword(account: string, password: string) {
    return ipcRenderer.invoke('auth:login-password', account, password)
  },
  loginBySms(mobile: string, code: string) {
    return ipcRenderer.invoke('auth:login-sms', mobile, code)
  },
  sendSmsCode(mobile: string) {
    return ipcRenderer.invoke('auth:send-sms-code', mobile)
  },
  loginByWechat(code: string) {
    return ipcRenderer.invoke('auth:login-wechat', code)
  },
  loginByOAuth2() {
    return ipcRenderer.invoke('auth:login-oauth2')
  },
  confirmOAuth2Link(action: string) {
    return ipcRenderer.invoke('auth:confirm-oauth2-link', action)
  },
  logout(account: string) {
    return ipcRenderer.invoke('auth:logout', account)
  },
  // ── 会话 API（基于 LangGraph checkpointer）──
  listConversations() {
    return ipcRenderer.invoke('conversation:list')
  },
  getConversation(id: string) {
    return ipcRenderer.invoke('conversation:get', id)
  },
  deleteConversation(id: string) {
    return ipcRenderer.invoke('conversation:delete', id)
  },
  renameConversation(id: string, title: string) {
    return ipcRenderer.invoke('conversation:rename', id, title)
  },
  saveTurnMeta(
    conversationId: string,
    turnIndex: number,
    meta: { model?: string; createdAt?: number; durationMs?: number }
  ) {
    return ipcRenderer.invoke('conversation:save-turn-meta', conversationId, turnIndex, meta)
  },
  // ── 工作模式 API ──
  getWorkMode() {
    return ipcRenderer.invoke('mode:get')
  },
  setWorkMode(mode: string) {
    return ipcRenderer.invoke('mode:set', mode)
  },
  checkSession() {
    return ipcRenderer.invoke('session:check')
  },
  // ── 工作空间 API ──
  listWorkspaces() {
    return ipcRenderer.invoke('workspace:list')
  },
  createWorkspace(name: string) {
    return ipcRenderer.invoke('workspace:create', name)
  },
  selectWorkspaceDir() {
    return ipcRenderer.invoke('workspace:select-dir')
  },
  useDefaultWorkspace() {
    return ipcRenderer.invoke('workspace:default')
  },
  openWorkspace(id: string) {
    return ipcRenderer.invoke('workspace:open', id)
  },
  openDefaultWorkspace() {
    return ipcRenderer.invoke('workspace:open-default')
  },
  deleteWorkspace(id: string) {
    return ipcRenderer.invoke('workspace:delete', id)
  },
  listWorkspaceFiles(workspaceId: string, relPath?: string) {
    return ipcRenderer.invoke('workspace:list-files', workspaceId, relPath)
  },
  readWorkspaceFile(workspaceId: string, relPath: string, cursor?: number) {
    return ipcRenderer.invoke('workspace:read-file', workspaceId, relPath, cursor)
  },
  readWorkspaceFileBytes(workspaceId: string, relPath: string) {
    return ipcRenderer.invoke('workspace:read-file-bytes', workspaceId, relPath)
  },
  readWorkspaceImageBytes(workspaceId: string, relPath: string) {
    return ipcRenderer.invoke('workspace:read-image-bytes', workspaceId, relPath)
  },
  readWorkspaceMediaBytes(workspaceId: string, relPath: string) {
    return ipcRenderer.invoke('workspace:read-media-bytes', workspaceId, relPath)
  },

  writeWorkspaceFile(workspaceId: string, relPath: string, bytes: Uint8Array | ArrayBuffer) {
    return ipcRenderer.invoke('workspace:write-file', workspaceId, relPath, bytes)
  },
  /** 打包导出：把工作空间内的文件/目录导出为 zip（落工作空间根目录） */
  exportWorkspaceZip(workspaceId: string, relPaths: string[], zipName?: string) {
    return ipcRenderer.invoke('workspace:export-zip', workspaceId, relPaths, zipName)
  },
  browserNavigate(url: string) {
    return ipcRenderer.invoke('browser:navigate', url)
  },
  browserOpenWorkspaceFile(workspaceId: string, relPath: string) {
    return ipcRenderer.invoke('browser:open-workspace-file', workspaceId, relPath)
  },
  browserBack() {
    return ipcRenderer.invoke('browser:back')
  },
  browserForward() {
    return ipcRenderer.invoke('browser:forward')
  },
  browserReload() {
    return ipcRenderer.invoke('browser:reload')
  },
  browserStop() {
    return ipcRenderer.invoke('browser:stop')
  },
  browserOpenExternal() {
    return ipcRenderer.invoke('browser:open-external')
  },
  browserSetBounds(rect: { x: number; y: number; width: number; height: number }) {
    return ipcRenderer.invoke('browser:set-bounds', rect)
  },
  browserSetVisible(visible: boolean) {
    return ipcRenderer.invoke('browser:set-visible', visible)
  },
  onBrowserState(
    callback: (state: {
      displayUrl: string
      canGoBack: boolean
      canGoForward: boolean
      isLoading: boolean
    }) => void
  ) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: { displayUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean }
    ): void => {
      callback(state)
    }
    ipcRenderer.on('browser:state-changed', handler)
    return () => ipcRenderer.removeListener('browser:state-changed', handler)
  },
  onBrowserLoadError(callback: (error: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => {
      callback(error)
    }
    ipcRenderer.on('browser:load-error', handler)
    return () => ipcRenderer.removeListener('browser:load-error', handler)
  },
  // ── 系统设置 API（机器级配置）──
  /** 全局字体缩放（webFrame.setZoomFactor；渲染层不直接 import electron） */
  setZoomFactor(ratio: number) {
    webFrame.setZoomFactor(ratio)
  },
  /** 获取当前渲染进程缩放系数（用于将 CSS 像素换算为窗口 DIP） */
  getZoomFactor() {
    return webFrame.getZoomFactor()
  },
  getAllSettings() {
    return ipcRenderer.invoke('config:get-all')
  },
  setSetting(key: string, value: unknown) {
    return ipcRenderer.invoke('config:set', key, value)
  },
  getStorageStats() {
    return ipcRenderer.invoke('config:storage-stats')
  },
  selectDefaultWorkspaceDir() {
    return ipcRenderer.invoke('config:select-workspace-dir')
  },
  selectKnowledgeDir() {
    return ipcRenderer.invoke('config:select-knowledge-dir')
  },
  openDataDir() {
    return ipcRenderer.invoke('config:open-data-dir')
  },
  getBrandLogo() {
    return ipcRenderer.invoke('config:get-brand-logo')
  },
  uploadBrandLogo(payload: BrandLogoUploadPayload) {
    return ipcRenderer.invoke('config:upload-brand-logo', payload)
  },
  resetBrandLogo() {
    return ipcRenderer.invoke('config:reset-brand-logo')
  },
  // ── 知识库设置 API（用户级：配置按登录用户隔离，未登录返回失败）──
  /** 批量读取各知识库的覆盖项（省略 kbIds = 该用户全部） */
  getKbSettings(kbIds?: string[]) {
    return ipcRenderer.invoke('knowledge:get-kb-settings', kbIds)
  },
  /** 全量替换某知识库的覆盖项（传 {} 即恢复全部跟随全局） */
  setKbSettings(kbId: string, overrides: Record<string, unknown>) {
    return ipcRenderer.invoke('knowledge:set-kb-settings', kbId, overrides)
  },
  // ── 知识库 API（用户级：知识库/文档/共享均按登录用户隔离）──
  /** 知识库列表（可按分组与关键词过滤） */
  listKnowledgeBases(options?: { kind?: string; keyword?: string }) {
    return ipcRenderer.invoke('knowledge:list-kbs', options)
  },
  createKnowledgeBase(input: { name: string; description?: string; kind?: string }) {
    return ipcRenderer.invoke('knowledge:create-kb', input)
  },
  updateKnowledgeBase(id: string, patch: { name?: string; description?: string }) {
    return ipcRenderer.invoke('knowledge:update-kb', id, patch)
  },
  deleteKnowledgeBase(id: string) {
    return ipcRenderer.invoke('knowledge:delete-kb', id)
  },
  /** 拖拽排序：ids 为该分类下全部知识库 id（顺序可变），返回排序后的全量列表 */
  reorderKnowledgeBases(kind: string, ids: string[]) {
    return ipcRenderer.invoke('knowledge:reorder-kbs', kind, ids)
  },
  /** 置顶 / 取消置顶：返回排序后的全量列表 */
  setKnowledgeBasePinned(id: string, pinned: boolean) {
    return ipcRenderer.invoke('knowledge:set-kb-pinned', id, pinned)
  },
  getKnowledgeStats() {
    return ipcRenderer.invoke('knowledge:stats')
  },
  listKnowledgeDocuments(kbId: string) {
    return ipcRenderer.invoke('knowledge:list-docs', kbId)
  },
  /** 导入文件（items 为「源绝对路径 + 库内相对路径」，保留上传目录结构） */
  importKnowledgeDocuments(
    kbId: string,
    items: unknown[],
    indexState?: string,
    config?: Record<string, unknown> | null
  ) {
    return ipcRenderer.invoke('knowledge:import', kbId, items, indexState, config)
  },
  /** 重建索引：省略 relPaths = 整库；传数组 = 这些文件/文件夹（按 relPath 前缀） */
  reindexKnowledge(kbId: string, relPaths?: string[]) {
    return ipcRenderer.invoke('knowledge:reindex', kbId, relPaths)
  },
  /** 重试失败文档（仅 status = failed 可重试） */
  retryKnowledgeDocument(kbId: string, relPath: string) {
    return ipcRenderer.invoke('knowledge:retry-doc', kbId, relPath)
  },
  /** 取消索引任务：省略 relPaths = 整库 */
  cancelKnowledgeIndex(kbId: string, relPaths?: string[]) {
    return ipcRenderer.invoke('knowledge:cancel-index', kbId, relPaths)
  },
  /** 重抽图谱：省略 relPaths = 整库（只跑抽取，用已存切片） */
  reextractKnowledgeGraph(kbId: string, relPaths?: string[]) {
    return ipcRenderer.invoke('knowledge:reextract-graph', kbId, relPaths)
  },
  /** 备份整个索引库到用户选择的位置（VACUUM INTO 一致性快照） */
  backupKnowledgeIndex() {
    return ipcRenderer.invoke('knowledge:backup-index')
  },
  /** 重建社区摘要（GraphRAG 全局检索侧；按整库实体图聚类） */
  rebuildKnowledgeCommunities(kbId: string) {
    return ipcRenderer.invoke('knowledge:rebuild-communities', kbId)
  },
  /** 检索（页面问答与会话工具同源；返回命中与降级标记） */
  searchKnowledge(
    kbId: string,
    query: string,
    options?: { topK?: number; mode?: 'hybrid' | 'vector' | 'bm25' }
  ) {
    return ipcRenderer.invoke('knowledge:search', kbId, query, options)
  },
  /** 订阅索引进度事件（返回取消订阅函数） */
  onKnowledgeIndexProgress(callback: (progress: unknown) => void): () => void {
    const listener = (_event: unknown, progress: unknown): void => callback(progress)
    ipcRenderer.on('knowledge:import-progress', listener)
    return () => ipcRenderer.removeListener('knowledge:import-progress', listener)
  },
  /** 发起知识库问答（结果走 ask-* 事件流） */
  askKnowledge(
    kbId: string,
    question: string,
    modelName?: string,
    history?: Array<{ question: string; answer: string }>
  ) {
    return ipcRenderer.invoke('knowledge:ask', kbId, question, modelName, history)
  },
  /** 取消本窗口正在进行的问答 */
  cancelKnowledgeAsk() {
    return ipcRenderer.invoke('knowledge:cancel-ask')
  },
  onKnowledgeAskCitation(callback: (payload: unknown) => void): () => void {
    return subscribeKnowledgeAskEvent('knowledge:ask-citation', callback)
  },
  onKnowledgeAskChunk(callback: (payload: unknown) => void): () => void {
    return subscribeKnowledgeAskEvent('knowledge:ask-chunk', callback)
  },
  onKnowledgeAskDone(callback: (payload: unknown) => void): () => void {
    return subscribeKnowledgeAskEvent('knowledge:ask-done', callback)
  },
  onKnowledgeAskError(callback: (payload: unknown) => void): () => void {
    return subscribeKnowledgeAskEvent('knowledge:ask-error', callback)
  },
  renameKnowledgeDocument(kbId: string, relPath: string, newName: string) {
    return ipcRenderer.invoke('knowledge:rename-doc', kbId, relPath, newName)
  },
  removeKnowledgeDocument(kbId: string, relPath: string) {
    return ipcRenderer.invoke('knowledge:remove-doc', kbId, relPath)
  },
  readKnowledgeFile(kbId: string, relPath: string, as: 'text' | 'bytes', cursor?: number) {
    return ipcRenderer.invoke('knowledge:read-file', kbId, relPath, as, cursor)
  },
  readKnowledgeImageBytes(kbId: string, relPath: string) {
    return ipcRenderer.invoke('knowledge:read-image-bytes', kbId, relPath)
  },
  /** 打开知识库所在目录（系统文件管理器；目录不存在时主进程会先创建） */
  openKnowledgeBaseDir(kbId: string) {
    return ipcRenderer.invoke('knowledge:open-dir', kbId)
  },
  /** 打开文件所在目录（在资源管理器中定位并选中该文件） */
  openKnowledgeFileDir(kbId: string, relPath: string) {
    return ipcRenderer.invoke('knowledge:open-dir', kbId, relPath)
  },
  createKnowledgeShare(input: {
    targetKind: 'library' | 'folder' | 'file'
    targetId: string
    targetName: string
    expiresInDays?: number
  }) {
    return ipcRenderer.invoke('knowledge:create-share', input)
  },
  listKnowledgeShares() {
    return ipcRenderer.invoke('knowledge:list-shares')
  },
  revokeKnowledgeShare(token: string) {
    return ipcRenderer.invoke('knowledge:revoke-share', token)
  },
  // ── 内置运行时管理 API ──
  listRuntimes() {
    return ipcRenderer.invoke('runtime:list')
  },
  installRuntime(id: string, version?: string) {
    return ipcRenderer.invoke('runtime:install', id, version)
  },
  uninstallRuntime(id: string) {
    return ipcRenderer.invoke('runtime:uninstall', id)
  },
  detectRuntime(id: string) {
    return ipcRenderer.invoke('runtime:detect', id)
  },
  onRuntimeProgress(
    callback: (data: {
      id: string
      phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
      percent: number
      receivedBytes: number
      totalBytes: number
      message?: string
    }) => void
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        id: string
        phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
        percent: number
        receivedBytes: number
        totalBytes: number
        message?: string
      }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('runtime:progress', handler)
    return () => ipcRenderer.removeListener('runtime:progress', handler)
  },
  // ── 自定义模型 API（机器级配置）──
  listModels() {
    return ipcRenderer.invoke('model:list')
  },
  addModel(input: {
    id: string
    name: string
    vendor: string
    url: string
    protocol: string
    apiKey: string
  }) {
    return ipcRenderer.invoke('model:add', input)
  },
  removeModel(id: string) {
    return ipcRenderer.invoke('model:remove', id)
  },
  updateModel(
    id: string,
    input: {
      id: string
      name: string
      vendor: string
      url: string
      protocol: string
      apiKey: string
    }
  ) {
    return ipcRenderer.invoke('model:update', id, input)
  },
  listModelProviders() {
    return ipcRenderer.invoke('model:list-providers')
  },
  // ── Web 技能同步 API ──
  oauth2: {
    getStatus() {
      return ipcRenderer.invoke('oauth2:status')
    },
    getScopeCatalog() {
      return ipcRenderer.invoke('oauth2:scope-catalog')
    },
    authorize(scopes?: string[]) {
      return ipcRenderer.invoke('oauth2:authorize', scopes)
    },
    revoke(scopes?: string[]) {
      return ipcRenderer.invoke('oauth2:revoke', scopes)
    }
  },
  skillSync: {
    getStatus() {
      return ipcRenderer.invoke('skill-sync:status')
    },
    authorize() {
      return ipcRenderer.invoke('skill-sync:authorize')
    },
    sync() {
      return ipcRenderer.invoke('skill-sync:sync')
    },
    getCachedSkills() {
      return ipcRenderer.invoke('skill-sync:cached')
    },
    loadLocal() {
      return ipcRenderer.invoke('skill-sync:load-local')
    },
    install(skillId: string) {
      return ipcRenderer.invoke('skill:install', skillId)
    },
    uninstall(skillId: string) {
      return ipcRenderer.invoke('skill:uninstall', skillId)
    },
    delete(skillId: string) {
      return ipcRenderer.invoke('skill:delete', skillId)
    },
    disconnect() {
      return ipcRenderer.invoke('skill-sync:disconnect')
    },
    onSyncProgress(callback: (data: SkillSyncProgress) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, data: SkillSyncProgress): void => {
        callback(data)
      }
      ipcRenderer.on('skill-sync:progress', handler)
      return () => ipcRenderer.removeListener('skill-sync:progress', handler)
    },
    onInstallProgress(callback: (data: SkillInstallProgress) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, data: SkillInstallProgress): void => {
        callback(data)
      }
      ipcRenderer.on('skill:install-progress', handler)
      return () => ipcRenderer.removeListener('skill:install-progress', handler)
    }
  },
  expert: {
    getStatus() {
      return ipcRenderer.invoke('expert-sync:status')
    },
    authorize() {
      return ipcRenderer.invoke('expert-sync:authorize')
    },
    sync() {
      return ipcRenderer.invoke('expert-sync:sync')
    },
    loadLocal() {
      return ipcRenderer.invoke('expert-sync:load-local')
    },
    deleteExpert(id: string) {
      return ipcRenderer.invoke('expert-sync:delete-expert', id)
    },
    disconnect() {
      return ipcRenderer.invoke('expert-sync:disconnect')
    },
    onSyncProgress(callback: (data: ExpertSyncProgress) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, data: ExpertSyncProgress): void => {
        callback(data)
      }
      ipcRenderer.on('expert-sync:progress', handler)
      return () => ipcRenderer.removeListener('expert-sync:progress', handler)
    }
  },
  automationTemplateSync: {
    getStatus() {
      return ipcRenderer.invoke('automation-template-sync:status')
    },
    authorize() {
      return ipcRenderer.invoke('automation-template-sync:authorize')
    },
    sync() {
      return ipcRenderer.invoke('automation-template-sync:sync')
    },
    loadLocal() {
      return ipcRenderer.invoke('automation-template-sync:load-local')
    },
    deleteTemplate(id: string) {
      return ipcRenderer.invoke('automation-template-sync:delete-template', id)
    },
    disconnect() {
      return ipcRenderer.invoke('automation-template-sync:disconnect')
    },
    onSyncProgress(callback: (data: AutomationTemplateSyncProgress) => void): () => void {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: AutomationTemplateSyncProgress
      ): void => {
        callback(data)
      }
      ipcRenderer.on('automation-template-sync:progress', handler)
      return () => ipcRenderer.removeListener('automation-template-sync:progress', handler)
    }
  },
  modelSync: {
    getStatus() {
      return ipcRenderer.invoke('model-sync:status')
    },
    authorize() {
      return ipcRenderer.invoke('model-sync:authorize')
    },
    sync() {
      return ipcRenderer.invoke('model-sync:sync')
    },
    disconnect() {
      return ipcRenderer.invoke('model-sync:disconnect')
    }
  },
  // 云知识库（只读）：列表类接口返回 { state, message, ... }，未授权时 state='auth-required'
  knowledgeCloud: {
    getStatus() {
      return ipcRenderer.invoke('knowledge-cloud:status')
    },
    list(params: {
      scope: 'personal' | 'public'
      page?: number
      pageSize?: number
      search?: string
    }) {
      return ipcRenderer.invoke('knowledge-cloud:list', params)
    },
    listInvitations() {
      return ipcRenderer.invoke('knowledge-cloud:invitations')
    },
    getKb(kbId: string) {
      return ipcRenderer.invoke('knowledge-cloud:get-kb', kbId)
    },
    listDocuments(params: {
      kbId: string
      page?: number
      pageSize?: number
      search?: string
      folder?: string
    }) {
      return ipcRenderer.invoke('knowledge-cloud:list-docs', params)
    },
    respondInvitation(shareId: string, accept: boolean) {
      return ipcRenderer.invoke('knowledge-cloud:respond-invitation', shareId, accept)
    },
    readFile(kbId: string, docId: string, as: 'text' | 'bytes', cursor?: number) {
      return ipcRenderer.invoke('knowledge-cloud:read-file', kbId, docId, as, cursor)
    },
    downloadDocument(kbId: string, docId: string, suggestedName?: string) {
      return ipcRenderer.invoke('knowledge-cloud:download-doc', kbId, docId, suggestedName)
    },
    disconnect() {
      return ipcRenderer.invoke('knowledge-cloud:disconnect')
    }
  },
  automation: {
    listTasks() {
      return ipcRenderer.invoke('automation:list-tasks')
    },
    getTask(id: string) {
      return ipcRenderer.invoke('automation:get-task', id)
    },
    createTask(draft: unknown) {
      return ipcRenderer.invoke('automation:create-task', draft)
    },
    updateTask(id: string, draft: unknown) {
      return ipcRenderer.invoke('automation:update-task', id, draft)
    },
    deleteTask(id: string) {
      return ipcRenderer.invoke('automation:delete-task', id)
    },
    setEnabled(id: string, enabled: boolean) {
      return ipcRenderer.invoke('automation:set-enabled', id, enabled)
    },
    runNow(id: string) {
      return ipcRenderer.invoke('automation:run-now', id)
    },
    getRun(id: string) {
      return ipcRenderer.invoke('automation:get-run', id)
    },
    listRuns(opts?: { taskId?: string; limit?: number; cursor?: number }) {
      return ipcRenderer.invoke('automation:list-runs', opts)
    },
    runStats(since?: number) {
      return ipcRenderer.invoke('automation:run-stats', since)
    },
    onChanged(callback: (payload: unknown) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
        callback(payload)
      }
      ipcRenderer.on('automation:changed', handler)
      return () => ipcRenderer.removeListener('automation:changed', handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
