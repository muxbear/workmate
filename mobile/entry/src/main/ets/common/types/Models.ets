/** 统一响应包装 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T | null
}

/** Service 层统一返回类型 */
export interface ResultOk<T> {
  ok: true
  value: T
}

export interface ResultFail {
  ok: false
  code: number
  message: string
}

export type Result<T> = ResultOk<T> | ResultFail

export interface UserProfile {
  nickname: string
  phone: string
  level: string
  avatarColor: string
}

export interface PointsQuota {
  used: number
  total: number
}

export interface PointsSummary {
  balance: number
  nextMilestone: number
  basic: PointsQuota
  gifted: PointsQuota
}

export interface Workspace {
  id: string
  name: string
  device?: string
}

export interface CloudTask {
  id: string
  title: string
  status: 'running' | 'done' | 'failed'
}

export type ChatMode = 'cloud' | 'desktop'

/** AI 回复结构化内容块 */
export interface TextBlock {
  type: 'text'
  content: string
}

export interface HeadingBlock {
  type: 'heading'
  content: string
}

export interface TableBlock {
  type: 'table'
  headers: string[]
  rows: string[][]
}

export interface ListBlock {
  type: 'list'
  items: string[]
}

/** 图片块(src 已解析为产物接口地址,由 ArtifactImage 带 token 拉取渲染) */
export interface ImageBlock {
  type: 'image'
  src: string
  alt: string
}

/**
 * 成片块(「视频创作专家」交付文档里的 HTML5 `<video>` 标签)。
 *
 * src 同样先解析为产物接口地址:接口需要 Authorization,不能直接交给
 * Video 组件,由 ArtifactVideo 带 token 拉到应用沙箱后再播放。
 */
export interface VideoBlock {
  type: 'video'
  src: string
  /** 成片说明(取自 `<video>` 内的兜底文本;无则空串) */
  caption: string
}

export type ContentBlock =
  TextBlock | HeadingBlock | TableBlock | ListBlock | ImageBlock | VideoBlock

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  blocks?: ContentBlock[]
  status: 'thinking' | 'done'
  createdAt: number
  /** 本轮交付物(按 turn 分组后挂载) */
  artifacts?: ChatArtifact[]
}

/** HTTP 请求体(显式接口,满足 arkts-no-untyped-obj-literals) */
export interface LoginBody {
  phone: string
  code: string
}

export interface OneClickBody {
  providerToken: string
}

export interface LogoutBody {
}

/** ApiResponse -> Result 转换(0=成功,401=未登录) */
export function toResult<T>(resp: ApiResponse<T>): Result<T> {
  if (resp.code === 0 && resp.data !== null) {
    return { ok: true, value: resp.data } as Result<T>
  }
  return { ok: false, code: resp.code, message: resp.message } as Result<T>
}

/** 会话产物(与 Web 后端 /api/chat/artifacts 返回结构一致) */
export interface ChatArtifact {
  /** 交付目录虚拟路径,如 /artifacts/<thread>/turn-1/文章标题.md */
  path: string
  name: string
  source_tool: string
  created_at: number
  mime_type?: string
  size?: number
  artifact_id?: string
  /** 持久化状态:ready / pending / failed / expired */
  status?: string
  /** 交付轮次(turn-<n>);老数据可能缺失 */
  turn?: string
}

/** 会话产物列表接口响应(/api/chat/artifacts/{threadId} 的 data) */
export type ChatArtifactList = Array<ChatArtifact>
