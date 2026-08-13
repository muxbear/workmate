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

export type ContentBlock = TextBlock | HeadingBlock | TableBlock | ListBlock

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  blocks?: ContentBlock[]
  status: 'thinking' | 'done'
  createdAt: number
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
