import { ElectronAPI } from '@electron-toolkit/preload'
import type { FileKind } from '../shared/file-kinds'

/** IPC 统一结果包裹（与主进程 auth-handlers 一致） */
export interface IpcResult<T> {
  success: boolean
  data?: T
  error?: string
}

/** 输入消息部件：纯文本段或文件引用（路径；文件内容由主进程权威读取） */
export interface MessageTextPart {
  type: 'text'
  text: string
}
export interface MessageFilePart {
  type: 'file'
  path: string
}
export type MessagePart = MessageTextPart | MessageFilePart
/** 会话内 AI 轮次展示元信息（实时发送时记录，历史回显时恢复） */
export interface MessageTurnMeta {
  model?: string
  createdAt?: number
  durationMs?: number
}

/** 文档产物文件（消息区可点击打开 + 右侧栏展示） */
export interface DocArtifactFile {
  name: string
  relPath: string
  ext: string
  workspaceId?: string | null
}

/** 右侧栏文档预览类型（与工作空间文件打开组件映射一致） */
export type ArtifactPreviewKind = 'text' | 'word' | 'pdf' | 'browser' | 'unsupported'

/** 主进程推送的文档产物元信息（agent:artifact-start 载荷） */
export interface AgentArtifactMeta {
  artifactId: string
  name: string
  relPath: string
  workspaceId: string | null
  ext: string
  preview: ArtifactPreviewKind
}

export interface AuthResult {
  token: string
  refreshToken: string
  user: { id: string; username: string; mobile?: string }
}

/** OAuth2 登录确认动作：switch-identity=切换登录身份；rebind=本地用户换绑 Web 账号 */
export type OAuth2LoginAction = 'switch-identity' | 'rebind'

/** OAuth2 登录结果（需要确认时 status=needs-confirmation） */
export interface OAuth2LoginResponse {
  status: 'logged-in' | 'needs-confirmation'
  user?: { id: string; username: string }
  action?: OAuth2LoginAction
  message?: string
  webUser?: WebUser
}

/** OAuth2 绑定状态 */
export interface OAuth2StatusResponse {
  linked: boolean
  webAccountId: string | null
  webUser?: WebUser | null
  /** 当前已授予的 scope（统一会话 token 的 scope 并集） */
  grantedScopes?: string[]
}

/** 桌面端可见的 OAuth2 scope 元数据（授权管理界面用） */
export interface OAuth2ScopeDescriptor {
  key: string
  label: string
  description: string
  group: string
  /** 必选 scope 不可关闭（服务端会强制保留） */
  required: boolean
  granted: boolean
}

/** 统一 OAuth2 授权 API */
export interface OAuth2API {
  getStatus(): Promise<IpcResult<OAuth2StatusResponse>>
  /** scope 目录 + 当前授予状态（设置-账号-授权管理） */
  getScopeCatalog(): Promise<IpcResult<OAuth2ScopeDescriptor[]>>
  /** 按需授权；缺省请求桌面默认全部权限，已授权时静默返回 */
  authorize(
    scopes?: string[]
  ): Promise<IpcResult<{ webUser: WebUser | null; grantedScopes: string[] }>>
  /** 撤销指定 scope 或整份授权（服务端 consent + 本地 token） */
  revoke(scopes?: string[]): Promise<IpcResult<{ grantedScopes: string[] }>>
}

export interface AgentAPI {
  openExternal: (url: string) => Promise<void>
  /** 打开系统浏览器跳转到 Web 版首页（地址由主进程 WORKMATE_WEB_FRONTEND_URL 配置） */
  openWebHome(): Promise<void>
  openWeChatAuth: (
    authUrl: string,
    redirectUri: string
  ) => Promise<{ code?: string; error?: string }>
  /** 发送消息：conversationId 由渲染层生成，主进程按会话合成 thread_id 并读取历史；parts 为保序消息部件（文本段 + 文件引用）或纯文本字符串；workspaceId 为当前任务选择的工作空间；regenerate 表示重新生成最后一条回复（主进程截断旧回复）；customModelId 为自定义模型 id（缺省用默认模型，主进程校验归属） */
  sendAgentMessage(
    conversationId: string,
    parts: MessagePart[] | string,
    workspaceId?: string,
    opts?: {
      regenerate?: boolean
      model?: string
      customModelId?: string
      backendKind?: 'filesystem' | 'shell'
      turnIndex?: number
      createdAt?: number
    }
  ): Promise<{ success: boolean; error?: string }>
  cancelAgentMessage(): void
  onAgentChunk(callback: (chunk: string) => void): () => void
  onAgentThinking(callback: (chunk: string) => void): () => void
  onAgentThinkingDone(callback: () => void): () => void
  onAgentDone(callback: () => void): () => void
  onAgentArtifactStart(callback: (meta: AgentArtifactMeta) => void): () => void
  onAgentArtifactChunk(callback: (data: { artifactId: string; text: string }) => void): () => void
  onAgentArtifactEnd(callback: (data: { artifactId: string; ok: boolean }) => void): () => void
  onAgentArtifactError(callback: (data: { artifactId: string; error: string }) => void): () => void
  /** 选中文件即时校验（存在性 + 类型分类 + 大小），返回 kind: text/image/pdf/document/unsupported/missing */
  inspectFile(path: string): Promise<
    IpcResult<{
      exists: boolean
      size: number
      maxBytes?: number
      kind: FileKind | 'missing'
    }>
  >
  /** 获取文件选择器选中文件的绝对路径（Electron 39 起 File.path 已移除，须走 webUtils） */
  getPathForFile(file: File): string
  /** AI 改写润色输入文本（主进程调 LLM，非流式）；data 为改写结果 */
  polishText(text: string): Promise<IpcResult<string>>
  /** 将远程图片 URL 解析为本地 ke-img:// 缓存地址（主进程下载并落盘；失败返回 error） */
  resolveRemoteImage(url: string): Promise<IpcResult<{ url: string }>>
  /** 设置当前选中的专家为子智能体；调用完成后才可发送消息 */
  setExperts(experts: DesktopExpert[]): Promise<IpcResult<null>>
}

export interface AuthAPI {
  loginByPassword(account: string, password: string): Promise<IpcResult<AuthResult>>
  loginBySms(mobile: string, code: string): Promise<IpcResult<AuthResult>>
  sendSmsCode(mobile: string): Promise<IpcResult<null>>
  loginByWechat(code: string): Promise<IpcResult<AuthResult>>
  loginByOAuth2(): Promise<IpcResult<OAuth2LoginResponse>>
  confirmOAuth2Link(action: OAuth2LoginAction): Promise<IpcResult<OAuth2LoginResponse>>
  getOAuth2Status(): Promise<IpcResult<OAuth2StatusResponse>>
  logout(account: string): Promise<IpcResult<null>>
}

/** 会话绑定的工作空间（checkpoint metadata 派生；无绑定为 undefined，归"默认空间"） */
export interface ConversationWorkspace {
  id: string
  name: string
  dir?: string
}

/** 会话列表项（基于 LangGraph checkpoint 派生：id 为会话 id，标题由首条消息派生） */
export interface Conversation {
  id: string
  title: string
  createAt: number
  updateAt: number
  workspace?: ConversationWorkspace | null
}

/** 会话内消息（checkpoint 中 AI 消息为消息块结构，reasoning 块提取为深度思考） */
export interface ConversationMessage {
  id: string
  role: string
  content: string
  reasoning?: string
  /** 该轮 AI 生成/涉及的文档文件清单（实时由流事件填充，回显从本地辅助表恢复） */
  files?: DocArtifactFile[]
  /** AI 轮次展示元信息（模型/开始时间/耗时；回显时恢复） */
  meta?: MessageTurnMeta
}

export interface ConversationAPI {
  listConversations(): Promise<IpcResult<Conversation[]>>
  getConversation(id: string): Promise<IpcResult<{ id: string; messages: ConversationMessage[] }>>
  deleteConversation(id: string): Promise<IpcResult<null>>
  /** 重命名会话（自定义标题，列表读取时优先） */
  renameConversation(id: string, title: string): Promise<IpcResult<null>>
  /** 保存某 AI 轮次的展示元信息（模型/开始时间/耗时；历史回显一致性用） */
  saveTurnMeta(
    conversationId: string,
    turnIndex: number,
    meta: MessageTurnMeta
  ): Promise<IpcResult<null>>
  /** 监听 AI 总结标题异步生成完成（主进程推送，侧栏即时刷新） */
  onConversationTitleUpdated(
    callback: (data: { conversationId: string; title: string }) => void
  ): () => void
  /** 监听 AI 总结标题生成失败（主进程推送错误信息，供对话页 toast 提示） */
  onConversationTitleError(
    callback: (data: { conversationId: string; error: string }) => void
  ): () => void
}

export interface ModeAPI {
  getWorkMode(): Promise<IpcResult<'local' | 'cloud'>>
  setWorkMode(mode: 'local' | 'cloud'): Promise<IpcResult<string>>
  /** 校验主进程会话（localStorage token 可能残留，主进程为权威） */
  checkSession(): Promise<IpcResult<{ loggedIn: boolean }>>
}

/** 工作空间（workspaces 表行；source: created=新建 / external=打开本地文件夹 / timestamp=旧版时间戳 / default=默认工作空间；userId 为 null 表示机器级共享的默认空间） */
export interface Workspace {
  id: string
  name: string
  path: string
  source: 'created' | 'external' | 'timestamp' | 'default'
  userId: string | null
  createdAt: number
}

/** 工作空间文件列表条目（relPath 为 '/' 分隔的相对路径） */
export interface WorkspaceFileEntry {
  name: string
  type: 'dir' | 'file'
  relPath: string
}

/** 工作空间文件内容（truncated 表示超过预览上限被截断） */
export interface WorkspaceFileContent {
  content: string
  truncated: boolean
  /** 续读游标：truncated 为 true 时回传可继续读取后续内容 */
  cursor?: number
  /** 抽取文本总字符数（转换型文档可提前得知） */
  totalChars?: number
}

/** 工作空间图片原始字节（聊天内嵌本地图片渲染用） */
export interface WorkspaceImageBytes {
  ext: string
  bytes: Uint8Array
}

/** 工作空间视频原始字节（消息/文档内嵌本地视频播放用） */
export interface WorkspaceMediaBytes {
  ext: string
  bytes: Uint8Array
}

/** 工作空间 Word/PDF 文件原始字节（doc 会被主进程转换为 docx 后返回）。 */
export interface WorkspaceFileBinary {
  name: string
  ext: string
  bytes: Uint8Array
}

export interface WorkspaceAPI {
  listWorkspaces(): Promise<IpcResult<Workspace[]>>
  createWorkspace(name: string): Promise<IpcResult<Workspace>>
  /** 打开系统目录选择窗口；用户取消时 data 为 null */
  selectWorkspaceDir(): Promise<IpcResult<Workspace | null>>
  /** 使用默认工作空间（系统设置配置的目录；未选择任何空间时的兜底） */
  useDefaultWorkspace(): Promise<IpcResult<Workspace>>
  openWorkspace(id: string): Promise<IpcResult<null>>
  /** 打开默认工作目录（~/.ke-work/workspace，未绑定空间的会话使用） */
  openDefaultWorkspace(): Promise<IpcResult<null>>
  /** 从列表中删除工作空间（仅删记录，不动磁盘文件夹） */
  deleteWorkspace(id: string): Promise<IpcResult<null>>
  /** 列出工作空间下相对路径目录的条目（顶层传空串） */
  listWorkspaceFiles(
    workspaceId: string,
    relPath?: string
  ): Promise<IpcResult<WorkspaceFileEntry[]>>
  /** 读取工作空间下文件文本内容 */
  readWorkspaceFile(
    workspaceId: string,
    relPath: string,
    cursor?: number
  ): Promise<IpcResult<WorkspaceFileContent>>
  /** 读取工作空间下 Word/PDF 文件原始字节 */
  readWorkspaceFileBytes(
    workspaceId: string,
    relPath: string
  ): Promise<IpcResult<WorkspaceFileBinary>>
  /** 读取工作空间下图片原始字节（供聊天内嵌本地图片渲染） */
  readWorkspaceImageBytes(
    workspaceId: string,
    relPath: string
  ): Promise<IpcResult<WorkspaceImageBytes>>

  /** 读取工作空间下视频原始字节（供正文 HTML5 <video> 本地播放） */
  readWorkspaceMediaBytes(
    workspaceId: string,
    relPath: string
  ): Promise<IpcResult<WorkspaceMediaBytes>>

  /** 保存工作空间下 Word 文件字节 */
  writeWorkspaceFile(
    workspaceId: string,
    relPath: string,
    bytes: Uint8Array | ArrayBuffer
  ): Promise<IpcResult<null>>

  /** 打包导出为 zip（写入工作空间根目录，返回导出的相对路径） */
  exportWorkspaceZip(
    workspaceId: string,
    relPaths: string[],
    zipName?: string
  ): Promise<IpcResult<WorkspaceZipExport>>
}

/** 工作空间 zip 导出结果 */
export interface WorkspaceZipExport {
  /** 导出文件在工作空间内的相对路径 */
  relPath: string
  /** 导出文件绝对路径 */
  absPath: string
  /** 打包的文件数量 */
  entries: number
  /** zip 字节数 */
  size: number
  /** 用户在「另存为」中取消时为 true（此时其它字段为空值） */
  canceled?: boolean
}

/** ~/.ke-work 存储统计（config:storage-stats） */
export interface StorageStats {
  baseDir: string
  usedBytes: number
  diskTotal: number
  diskFree: number
  /** 统计超时降级（仅统计了部分目录） */
  partial?: boolean
}

/** 系统设置快照（config:get-all；settings 为扁平 key 映射，meta 供 UI 显示真实值） */
export interface SettingsSnapshot {
  settings: Record<string, unknown>
  meta: { dataBaseDir: string; defaultWorkspaceDir: string; defaultKnowledgeDir: string }
}

/** 系统 LOGO 上传入参（config:upload-brand-logo；bytes 为图片原始字节） */
export interface BrandLogoUploadPayload {
  /** 原始文件名（仅作提示，类型判定以字节为准） */
  name?: string
  bytes: ArrayBuffer | Uint8Array
}

/** 系统 LOGO 快照（config:get-brand-logo / upload / reset） */
export interface BrandLogoSnapshot {
  /** settings.json 持久化值（文件名）；空串 = 未自定义 */
  fileName: string
  /** 可直接用于 <img src>；未自定义为空串 */
  dataUrl: string
  /** 是否已自定义（UI 据此决定是否显示「恢复默认」） */
  customized: boolean
}

/** 内置运行时类型标识 */
export type RuntimeId = 'python' | 'node' | 'git'

/** 内置运行时安装状态 */
export type RuntimeStatus = 'not-installed' | 'installed' | 'installing' | 'error'

/** 内置运行时信息（渲染层消费） */
export interface RuntimeInfo {
  id: RuntimeId
  name: string
  description: string
  mark: string
  color: string
  status: RuntimeStatus
  version?: string
  executablePath?: string
  installPath?: string
  enabled: boolean
  error?: string
}

/** 内置运行时安装进度事件 */
export interface RuntimeProgress {
  id: RuntimeId
  phase: 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  /** 下载进度百分比 0–100 */
  percent: number
  receivedBytes: number
  totalBytes: number
  message?: string
}

export interface RuntimeAPI {
  /** 列出所有内置运行时状态（机器级，不依赖登录态） */
  listRuntimes(): Promise<IpcResult<RuntimeInfo[]>>
  /** 安装运行时（完成后返回最新列表） */
  installRuntime(id: RuntimeId, version?: string): Promise<IpcResult<RuntimeInfo[]>>
  /** 卸载运行时（完成后返回最新列表） */
  uninstallRuntime(id: RuntimeId): Promise<IpcResult<RuntimeInfo[]>>
  /** 探测已安装运行时版本 */
  detectRuntime(id: RuntimeId): Promise<IpcResult<string | null>>
  /** 监听安装进度事件（主进程推送） */
  onRuntimeProgress(callback: (data: RuntimeProgress) => void): () => void
}

export interface ConfigAPI {
  /** 全局字体缩放（webFrame.setZoomFactor 封装；渲染层不直接 import electron） */
  setZoomFactor(ratio: number): void
  /** 获取当前渲染进程缩放系数（用于将 CSS 像素换算为窗口 DIP） */
  getZoomFactor(): number
  /** 读取全部系统设置（默认值合并；机器级，不依赖登录态） */
  getAllSettings(): Promise<IpcResult<SettingsSnapshot>>
  /** 修改单项设置（主进程校验：白名单 + 类型/枚举/格式/区间；非法返回 error） */
  setSetting(key: string, value: unknown): Promise<IpcResult<null>>
  /** ~/.ke-work 目录占用真实统计 + 磁盘容量 */
  getStorageStats(): Promise<IpcResult<StorageStats>>
  /** 系统目录选择对话框；用户取消时 data 为 null */
  selectDefaultWorkspaceDir(): Promise<IpcResult<string | null>>
  /** 知识库目录选择对话框（不迁移旧目录）；用户取消时 data 为 null */
  selectKnowledgeDir(): Promise<IpcResult<string | null>>
  /** 在系统资源管理器中打开 ~/.ke-work */
  openDataDir(): Promise<IpcResult<null>>
  /** 读取当前系统 LOGO（未自定义时 fileName/dataUrl 为空串） */
  getBrandLogo(): Promise<IpcResult<BrandLogoSnapshot>>
  /** 上传系统 LOGO（主进程按魔数校验类型与体积后落盘） */
  uploadBrandLogo(payload: BrandLogoUploadPayload): Promise<IpcResult<BrandLogoSnapshot>>
  /** 恢复内置默认 LOGO（删除自定义文件并清空设置） */
  resetBrandLogo(): Promise<IpcResult<BrandLogoSnapshot>>
}

/**
 * 知识库「按库覆盖」配置项短 key（去掉了 knowledge. 前缀）。
 * 与主进程 src/main/knowledge/knowledge-schema.ts 的清单一致（由单测钉住）；
 * 不含「本地存储 / 存放目录」——它是整个索引库的机器级位置，不按知识库区分。
 */
export type KnowledgeOverrideKey =
  | 'maxUploadSize'
  | 'uploadTimeout'
  | 'maxFilesPerBatch'
  | 'chunkStrategy'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'vectorDimensions'
  | 'embeddingModel'
  | 'sparseRetrieval'
  | 'bm25K1'
  | 'bm25B'
  | 'hybridWeight'
  | 'rerankEnabled'
  | 'rerankModel'
  | 'topK'
  | 'graphEnabled'
  | 'graphModel'

/** 单个知识库的覆盖项：稀疏结构，未出现的 key 表示「跟随全局」 */
export type KnowledgeOverrides = Partial<Record<KnowledgeOverrideKey, unknown>>

/** 知识库来源分组：本地创建 / 他人共享 / 云端 */
export type KnowledgeKind = 'local' | 'shared' | 'cloud'

/** 文档索引状态：未索引 / 已建立索引 / 自定义索引 */
export type KnowledgeIndexState = 'none' | 'default' | 'custom'

/** 文档处理状态（索引管线落地前恒为 none） */
export type KnowledgeDocStatus = 'none' | 'queued' | 'indexing' | 'indexed' | 'failed'

/** 知识库摘要 */
export interface KnowledgeBaseSummary {
  id: string
  userId: string
  name: string
  description: string
  kind: KnowledgeKind
  status: string
  docsCount: number
  sizeBytes: number
  /** 手动拖拽排序序号（同分类内越小越靠前） */
  sortOrder: number
  /** 是否置顶（置顶始终排在未置顶之前） */
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** 文档元信息（不含绝对路径等主进程内部字段） */
export interface KnowledgeDocumentMeta {
  id: string
  kbId: string
  name: string
  type: string
  sizeBytes: number
  /** 相对知识库根目录的路径，'/' 分隔（文件树据此还原层级） */
  relPath: string
  indexState: KnowledgeIndexState
  status: KnowledgeDocStatus
  errorMessage: string | null
  uploadedAt: number
  updatedAt: number
}

/** 单个文件的导入结果 */
export interface KnowledgeImportOutcome {
  name: string
  relPath: string
  reason: string
}

export interface KnowledgeImportResult {
  accepted: KnowledgeDocumentMeta[]
  skipped: KnowledgeImportOutcome[]
  failed: KnowledgeImportOutcome[]
}

/** 知识库概览统计（文件维度；切片/实体随索引能力提供） */
/** 知识库图片原始字节（Markdown 插图渲染用） */
export interface KnowledgeImageBytes {
  ext: string
  bytes: Uint8Array
}

export interface KnowledgeStats {
  kbCount: number
  docCount: number
  sizeBytes: number
  latestUpdatedAt: number
}

/** 共享记录 */
export interface KnowledgeShare {
  id: string
  userId: string
  targetKind: 'library' | 'folder' | 'file'
  targetId: string
  targetName: string
  token: string
  url: string
  permission: string
  expiresAt: number | null
  revokedAt: number | null
  createdAt: number
}

export interface KnowledgeAPI {
  /** 批量读取各知识库的覆盖项（省略 kbIds = 该用户全部；未配置的知识库返回 {}） */
  getKbSettings(kbIds?: string[]): Promise<IpcResult<Record<string, KnowledgeOverrides>>>
  /** 全量替换某知识库的覆盖项（传 {} 即恢复全部跟随全局；主进程校验白名单 + 区间 + 枚举） */
  setKbSettings(kbId: string, overrides: KnowledgeOverrides): Promise<IpcResult<KnowledgeOverrides>>
  // ── 知识库本体（用户级）──
  listKnowledgeBases(options?: {
    kind?: KnowledgeKind
    keyword?: string
  }): Promise<IpcResult<KnowledgeBaseSummary[]>>
  createKnowledgeBase(input: {
    name: string
    description?: string
    kind?: KnowledgeKind
  }): Promise<IpcResult<KnowledgeBaseSummary>>
  updateKnowledgeBase(
    id: string,
    patch: { name?: string; description?: string }
  ): Promise<IpcResult<KnowledgeBaseSummary>>
  deleteKnowledgeBase(
    id: string
  ): Promise<IpcResult<{ removedDocs: number; overridesCleared: boolean }>>
  /** 拖拽排序：ids 为该分类下全部知识库 id（顺序可变），返回排序后的全量列表 */
  reorderKnowledgeBases(
    kind: KnowledgeKind,
    ids: string[]
  ): Promise<IpcResult<KnowledgeBaseSummary[]>>
  /** 置顶 / 取消置顶：返回排序后的全量列表 */
  setKnowledgeBasePinned(id: string, pinned: boolean): Promise<IpcResult<KnowledgeBaseSummary[]>>
  getKnowledgeStats(): Promise<IpcResult<KnowledgeStats>>
  listKnowledgeDocuments(kbId: string): Promise<IpcResult<KnowledgeDocumentMeta[]>>
  /** 导入文件：items 为「源绝对路径 + 库内相对路径」；索引未开放时只接受 indexState = 'none' */
  importKnowledgeDocuments(
    kbId: string,
    items: Array<{ srcPath: string; relPath: string }>,
    indexState?: KnowledgeIndexState
  ): Promise<IpcResult<KnowledgeImportResult>>
  renameKnowledgeDocument(
    kbId: string,
    relPath: string,
    newName: string
  ): Promise<IpcResult<{ relPath: string; renamed: number }>>
  removeKnowledgeDocument(kbId: string, relPath: string): Promise<IpcResult<{ removed: number }>>
  /** 读取库内文件：text 走文本加载器，bytes 返回原始字节（预览用） */
  readKnowledgeFile(
    kbId: string,
    relPath: string,
    as: 'text' | 'bytes',
    cursor?: number
  ): Promise<
    IpcResult<{
      content?: string
      truncated?: boolean
      cursor?: number
      totalChars?: number
      bytes?: Uint8Array
      ext: string
      name: string
    }>
  >
  /** 读取知识库内图片原始字节（Markdown 相对路径插图渲染用） */
  readKnowledgeImageBytes(kbId: string, relPath: string): Promise<IpcResult<KnowledgeImageBytes>>
  /** 在系统文件管理器中打开知识库目录（目录不存在时主进程会先创建） */
  openKnowledgeBaseDir(kbId: string): Promise<IpcResult<null>>
  /** 在系统文件管理器中打开文件所在目录，并尽量选中该文件 */
  openKnowledgeFileDir(kbId: string, relPath: string): Promise<IpcResult<null>>
  createKnowledgeShare(input: {
    targetKind: 'library' | 'folder' | 'file'
    targetId: string
    targetName: string
    expiresInDays?: number
  }): Promise<IpcResult<KnowledgeShare>>
  listKnowledgeShares(): Promise<IpcResult<KnowledgeShare[]>>
  revokeKnowledgeShare(token: string): Promise<IpcResult<{ revoked: boolean }>>
}

/** 模型协议类型 */
export type ModelProtocol = 'openai-chat' | 'openai-response' | 'anthropic'

/** 提供商三种协议端点 */
export interface ModelProviderUrls {
  openaiChat: string
  openaiResponse: string
  anthropic: string
}

/** 自定义模型记录（models.json 元素；id 即 API 模型标识，name 为显示名） */
export interface CustomModel {
  id: string
  name: string
  vendor: string
  url: string
  protocol?: ModelProtocol
  apiKey: string
  supportsToolCall: boolean
  supportsImages: boolean
  supportsReasoning: boolean
  reasoning?: { defaultEffort: string; supportedEfforts: string[] }
}

/** 提供商（models.json 内 providers 元素；plans 为提供方式列表，models 为该家可提供的模型） */
export interface ModelProvider {
  id: string
  /** 提供商中文名（如 深度求索） */
  name: string
  /** 提供商英文名（如 DeepSeek；无则不显示） */
  nameEn?: string
  /** LOGO 标识（ProviderLogo 组件按此渲染） */
  logo: string
  defaultUrl: string
  urls?: ModelProviderUrls
  plans: { type: string }[]
  /** 该提供商可提供的模型列表（模型名称下拉数据源） */
  models: string[]
}

export interface ModelAPI {
  /** 全部自定义模型 */
  listModels(): Promise<IpcResult<CustomModel[]>>
  /** 添加自定义模型（主进程校验：id 唯一、url 格式等；失败返回 error） */
  addModel(input: {
    id: string
    name: string
    vendor: string
    url: string
    protocol: ModelProtocol
    apiKey: string
  }): Promise<IpcResult<CustomModel>>
  /** 移除自定义模型（幂等） */
  removeModel(id: string): Promise<IpcResult<null>>
  /** 更新自定义模型（按 id 定位；id 本身不可改，其余字段可改） */
  updateModel(
    id: string,
    input: {
      id: string
      name: string
      vendor: string
      url: string
      protocol: ModelProtocol
      apiKey: string
    }
  ): Promise<IpcResult<CustomModel>>
  /** 提供商列表（models.json 内 providers；缺失时主进程用内置种子） */
  listModelProviders(): Promise<IpcResult<ModelProvider[]>>
}

/** 内嵌浏览器状态 */
export interface BrowserState {
  displayUrl: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

export interface BrowserAPI {
  browserNavigate(url: string): Promise<IpcResult<null>>
  browserOpenWorkspaceFile(
    workspaceId: string,
    relPath: string
  ): Promise<IpcResult<{ displayUrl: string }>>
  browserBack(): Promise<IpcResult<null>>
  browserForward(): Promise<IpcResult<null>>
  browserReload(): Promise<IpcResult<null>>
  browserStop(): Promise<IpcResult<null>>
  browserOpenExternal(): Promise<IpcResult<null>>
  browserSetBounds(rect: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<IpcResult<null>>
  browserSetVisible(visible: boolean): Promise<IpcResult<null>>
  onBrowserState(callback: (state: BrowserState) => void): () => void
  onBrowserLoadError(callback: (error: string) => void): () => void
}

/** Web 技能同步状态 */
export type SkillSyncStatus = {
  status: 'unknown' | 'unauthorized' | 'authorized' | 'syncing'
  webUser?: WebUser | null
}

/** Web 端授权用户信息 */
export interface WebUser {
  id: string
  nickname: string
  avatar?: string
}

/** 技能包内单个文件的元信息（主进程同步落盘时记录） */
export interface SkillFileEntry {
  /** 相对技能根目录的路径，'/' 分隔 */
  path: string
  size: number
  sha256: string
}

/** 技能脚本运行时类型 */
export type SkillRuntimeKind = 'python' | 'node'

/** 技能脚本运行时需求（同步 / 安装时探测得到） */
export interface SkillRuntimeRequirement {
  /** 需要的运行时；空数组表示技能不含脚本 */
  kinds: SkillRuntimeKind[]
  /** 入口脚本相对路径（frontmatter module 或首个脚本） */
  entry: string | null
  /** 探测依据（展示 / 排查用） */
  reasons?: string[]
}

/** 桌面端技能列表项（Web SkillInfo 映射 + 本地安装信息） */
export interface DesktopSkill {
  id: string
  name: string
  desc: string
  category: string
  icon: string
  color: string
  enabled: boolean
  isBuiltin: boolean
  source: string
  /** 本地技能目录名（~/.ke-work/skills/<dirName>） */
  dirName?: string
  /** 技能包内文件清单（同步落盘时记录） */
  files?: SkillFileEntry[]
  /** 脚本运行时需求（同步 / 安装时探测） */
  runtime?: SkillRuntimeRequirement | null
  /** 是否已安装到主智能体 */
  installed?: boolean
  /** 安装时间戳 */
  installedAt?: number | null
  /** 服务端已删除但本地保留 */
  stale?: boolean
  /** skills.json 有条目但磁盘目录缺失 */
  missing?: boolean
}

/** 技能同步阶段（主进程 → 渲染层进度事件） */
export type SkillSyncPhase = 'authorize' | 'fetch' | 'download' | 'save' | 'load' | 'done' | 'error'

/** 技能同步进度（主进程推送） */
export interface SkillSyncProgress {
  phase: SkillSyncPhase
  /** 0–100 单调递增进度 */
  percent: number
  message?: string
  received?: number
  total?: number
  /** 当前处理的技能名 */
  skill?: string
}

/** 技能同步增量统计 */
export interface SkillSyncStats {
  added: number
  updated: number
  unchanged: number
  failed: number
  stale: number
}

/** 本地技能快照（skills.json 读回结果） */
export interface SkillLocalSnapshot {
  skills: DesktopSkill[]
  syncedAt: number
}

/** 技能安装阶段（主进程 → 渲染层进度事件） */
export type SkillInstallPhase = 'detect' | 'runtime' | 'deps' | 'write' | 'agent' | 'done' | 'error'

/** 技能安装进度（主进程推送） */
export interface SkillInstallProgress {
  skillId: string
  skillName: string
  phase: SkillInstallPhase
  /** 0–100 单调递增进度 */
  percent: number
  message?: string
  /** 正在检查 / 安装的运行时 */
  runtimeId?: RuntimeId
  /** 运行时安装进度（透传自 BinaryManager） */
  runtimeProgress?: RuntimeProgress
}

export interface SkillSyncAPI {
  getStatus(): Promise<IpcResult<SkillSyncStatus>>
  authorize(): Promise<IpcResult<{ webUser: WebUser | null }>>
  /** 拉取技能列表 → 增量下载技能包 → 落盘 → 读回 */
  sync(): Promise<IpcResult<{ skills: DesktopSkill[]; syncedAt: number; stats: SkillSyncStats }>>
  getCachedSkills(): Promise<IpcResult<DesktopSkill[]>>
  /** 读取 ~/.ke-work/skills/skills.json；文件缺失返回 null */
  loadLocal(): Promise<IpcResult<SkillLocalSnapshot | null>>
  /** 安装技能到主智能体（含脚本运行时环境准备） */
  install(skillId: string): Promise<IpcResult<{ skill: DesktopSkill }>>
  /** 从主智能体移除技能（保留本地技能包） */
  uninstall(skillId: string): Promise<IpcResult<{ skill: DesktopSkill }>>
  /** 删除本地技能（卸载 + 删除本地技能包；重新同步时以服务端为准） */
  delete(skillId: string): Promise<IpcResult<{ skill: DesktopSkill }>>
  disconnect(): Promise<IpcResult<null>>
  /** 订阅同步进度事件，返回取消订阅函数 */
  onSyncProgress(callback: (data: SkillSyncProgress) => void): () => void
  /** 订阅安装进度事件，返回取消订阅函数 */
  onInstallProgress(callback: (data: SkillInstallProgress) => void): () => void
}

/** 桌面端专家绑定的 MCP 工具连接信息（用于注册 MCP 客户端） */
export interface DesktopMcpConfig {
  mcpToolId: string
  mcpToolName: string
  transport: string
  url: string
  sseUrl: string
  streamableHttpUrl: string
  config: Record<string, unknown>
  enabled: boolean
}

/** 桌面端专家列表项（Web ExpertSyncItem 映射后的结果） */
export interface DesktopExpert {
  id: string
  name: string
  title: string
  tags: string[]
  desc: string
  color: string
  icon: string
  category: string
  rating: number
  users: string
  initials: string
  systemPrompt: string
  tools: string[]
  providerId: string | null
  modelId: string | null
  modelName: string | null
  modelType: string | null
  skills: unknown[]
  mcpConfigs: DesktopMcpConfig[]
  promptTemplate: string
  expertiseAreas: string[]
  /** 声明式能力（image.generate / document.assemble 等）；老数据可能缺失 */
  capabilities?: string[]
  isExpert: boolean
}

/** Web 专家同步状态 */
export type ExpertSyncStatus = {
  status: 'unauthorized' | 'authorized'
  webUser: WebUser | null
}

/** 专家同步阶段（主进程 → 渲染层进度事件） */
export type ExpertSyncPhase = 'authorize' | 'fetch' | 'save' | 'load' | 'done' | 'error'

export interface ExpertSyncProgress {
  phase: ExpertSyncPhase
  /** 0–100 单调递增进度 */
  percent: number
  /** 阶段提示文案 */
  message?: string
  received?: number
  total?: number
}

export interface ExpertSyncAPI {
  getStatus(): Promise<IpcResult<ExpertSyncStatus>>
  authorize(): Promise<IpcResult<{ webUser: WebUser | null }>>
  /** 拉取 → 落盘 → 读回，返回与磁盘一致的专家数据 */
  sync(): Promise<IpcResult<{ experts: DesktopExpert[]; syncedAt: number }>>
  /** 读取 ~/.ke-work/experts/experts.json；文件缺失返回 null */
  loadLocal(): Promise<IpcResult<{ experts: DesktopExpert[]; syncedAt: number } | null>>
  disconnect(): Promise<IpcResult<null>>
  /** 订阅同步进度事件，返回取消订阅函数 */
  onSyncProgress(callback: (data: ExpertSyncProgress) => void): () => void
}

/** Web 模型同步状态 */
export type ModelSyncStatus = {
  status: 'unauthorized' | 'authorized'
  webUser: WebUser | null
}

/** Web 模型同步结果 */
export interface ModelSyncResult {
  providerCount: number
  modelCount: number
  syncedAt: number
}

export interface ModelSyncAPI {
  getStatus(): Promise<IpcResult<ModelSyncStatus>>
  authorize(): Promise<IpcResult<{ webUser: WebUser | null }>>
  sync(): Promise<IpcResult<ModelSyncResult>>
  disconnect(): Promise<IpcResult<null>>
}

/** 渲染层可见的完整 API 形状 */
/** 自动化：频率与有效期配置（与前端 AutomationPage 的 TaskSchedule 一致） */
export interface AutomationSchedule {
  freqGroup: 'cycle' | 'interval'
  cycleKind: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
  intervalKind: 'weekly' | 'hourly'
  onceDate: string
  onceTime: string
  weekDays: number[]
  monthDay: number
  yearMonth: number
  yearDay: number
  weekIntervalDays: number[]
  hourInterval: number
  validityMode: 'forever' | 'range'
  validFrom: string
  validFromTime: string
  validTo: string
  validToTime: string
}

/** 自动化运行状态 / 触发来源 / 失败分类 */
export type AutomationRunStatus =
  'running' | 'success' | 'failed' | 'skipped' | 'canceled' | 'interrupted'
export type AutomationRunTrigger = 'schedule' | 'manual' | 'catchup' | 'retry'
export type AutomationErrorCode =
  | 'model_not_configured'
  | 'workspace_unavailable'
  | 'file_missing'
  | 'timeout'
  | 'agent_error'
  | 'interrupted'

/** 自动化任务（列表 + 编辑回填） */
export interface AutomationTask {
  id: string
  userId: string
  title: string
  promptText: string
  promptParts: MessagePart[]
  icon: string
  source: 'custom' | 'template'
  templateId: string | null
  schedule: AutomationSchedule
  freqSummary: string
  validitySummary: string
  validFromTs: number | null
  validToTs: number | null
  model: string | null
  customModelId: string | null
  expertId: string | null
  expertName: string | null
  contextMode: 'default' | 'local' | 'knowledge'
  skillIds: string[]
  workspaceId: string | null
  workspaceName: string | null
  fullAccess: boolean
  enabled: boolean
  status: 'enabled' | 'paused' | 'expired' | 'finished'
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: AutomationRunStatus | null
  runCount: number
  failCount: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 自动化任务草稿（新建 / 编辑提交，除提示词与频率外都可省略） */
export interface AutomationTaskDraft {
  title?: string
  promptText: string
  promptParts: MessagePart[]
  icon?: string
  source?: 'custom' | 'template'
  templateId?: string | null
  schedule: AutomationSchedule
  model?: string | null
  customModelId?: string | null
  expertId?: string | null
  expertName?: string | null
  contextMode?: 'default' | 'local' | 'knowledge'
  skillIds?: string[]
  workspaceId?: string | null
  workspaceName?: string | null
  fullAccess?: boolean
}

/** 自动化运行记录 */
export interface AutomationRun {
  id: string
  taskId: string
  userId: string
  trigger: AutomationRunTrigger
  status: AutomationRunStatus
  scheduledAt: number | null
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  conversationId: string | null
  threadId: string | null
  outputPreview: string | null
  /** 完整输出正文（运行结果详情） */
  outputText: string | null
  /** 本次运行使用的模型 */
  model: string | null
  errorCode: AutomationErrorCode | null
  errorMessage: string | null
  artifacts: unknown[]
  tokenUsage: Record<string, number> | null
}

/** 自动化运行统计（本周） */
export interface AutomationRunStats {
  total: number
  success: number
  failed: number
  skipped: number
  running: number
  avgDurationMs: number | null
}

/** 自动化 API（任务 CRUD、运行记录与统计） */
export interface AutomationAPI {
  listTasks(): Promise<IpcResult<AutomationTask[]>>
  getTask(id: string): Promise<IpcResult<AutomationTask>>
  createTask(draft: AutomationTaskDraft): Promise<IpcResult<AutomationTask>>
  updateTask(id: string, draft: AutomationTaskDraft): Promise<IpcResult<AutomationTask>>
  deleteTask(id: string): Promise<IpcResult<number>>
  setEnabled(id: string, enabled: boolean): Promise<IpcResult<AutomationTask>>
  runNow(id: string): Promise<IpcResult<{ runId: string }>>
  getRun(id: string): Promise<IpcResult<AutomationRun>>
  listRuns(opts?: {
    taskId?: string
    limit?: number
    cursor?: number
  }): Promise<IpcResult<AutomationRun[]>>
  runStats(since?: number): Promise<IpcResult<AutomationRunStats>>
  /** 订阅任务 / 运行状态变化（主进程广播） */
  onChanged(callback: (payload: AutomationChangedEvent) => void): () => void
}

/** 自动化状态变化事件 */
export interface AutomationChangedEvent {
  taskId: string
  runId?: string
  phase: 'started' | 'finished'
  status?: AutomationRunStatus
}

export interface KeWorkWindowApi
  extends
    AgentAPI,
    AuthAPI,
    ConversationAPI,
    ModeAPI,
    WorkspaceAPI,
    ConfigAPI,
    ModelAPI,
    BrowserAPI,
    RuntimeAPI,
    KnowledgeAPI {
  oauth2: OAuth2API
  skillSync: SkillSyncAPI
  expert: ExpertSyncAPI
  modelSync: ModelSyncAPI
  automation: AutomationAPI
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KeWorkWindowApi
  }
}
