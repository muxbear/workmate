import type { WebUser } from '../../shared/contracts'
import { OAuth2AuthorizationProvider, toWebUser } from '../oauth2/OAuth2AuthorizationProvider'
import { DEFAULT_WEB_API_BASE_URL, WebApiClient } from './web-api-client'

/**
 * 同步源授权状态（各源状态契约的结构子集：'unknown'/'syncing' 等扩展态由渲染层本地维护）。
 */
export interface SyncAuthorizationState {
  status: 'unauthorized' | 'authorized'
  webUser: WebUser | null
}

export interface BaseSyncServiceOptions {
  /** 统一 OAuth2 授权提供者（所有 Web 能力共用一份会话 token） */
  authorization: OAuth2AuthorizationProvider
  /** 该同步源所需 scope（status 快照与授权共用） */
  scopes: readonly string[]
  /** 授权原因标识（授权中心展示来源） */
  reason: string
  apiBaseUrl?: string
}

/**
 * 同步服务公共骨架（Template Method 的基类部分）。
 *
 * 历史问题：四个同步源（技能 / 专家 / 定时模板 / 模型）各自复制「授权三件套 + HTTP request
 * 样板 + 进度上报」，且互有漂移（错误解析差异、尾斜杠归一化只做了三处）。
 * 现收敛为：授权三件套、HTTP 客户端、进度上报在此实现一次；
 * 各源只保留自己的 sync 流程、映射与合并规则。
 *
 * 同步流程的偏差已显式化（见各子类 sync 注释）：
 * - 分页：定时模板源翻页取全量；技能 / 专家源沿用单页语义（服务器数据量未超上限，统一需产品确认）；
 * - 进度：模型源无进度事件（TProgress 用缺省）。
 */
export abstract class BaseSyncService<
  TProgress extends { phase: string; percent: number; message?: string } = {
    phase: string
    percent: number
    message?: string
  }
> {
  protected readonly http: WebApiClient
  protected readonly authorization: OAuth2AuthorizationProvider
  private readonly scopes: readonly string[]
  private readonly reason: string

  constructor(options: BaseSyncServiceOptions) {
    this.authorization = options.authorization
    this.scopes = options.scopes
    this.reason = options.reason
    this.http = new WebApiClient(options.apiBaseUrl || DEFAULT_WEB_API_BASE_URL)
  }

  /** 授权状态快照 */
  getStatus(localUserId: string): SyncAuthorizationState {
    const snapshot = this.authorization.getSnapshot(localUserId, this.scopes)
    return { status: snapshot.status, webUser: toWebUser(snapshot.webUser) }
  }

  /** 确保所需 scope 已授权；已授权时不打开浏览器 */
  async authorize(localUserId: string): Promise<{ webUser: WebUser | null }> {
    await this.authorization.ensureAuthorization(localUserId, this.scopes, { reason: this.reason })
    return { webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  /** 同步前置：校验授权并取 access token（子类 sync() 开头调用） */
  protected async ensureSyncAccess(
    localUserId: string
  ): Promise<{ accessToken: string; webUser: WebUser | null }> {
    const accessToken = await this.authorization.ensureAccessToken(localUserId, this.scopes)
    return { accessToken, webUser: toWebUser(this.authorization.getWebUser(localUserId)) }
  }

  /** 断开同步：仅清理本地会话 token（决策 D1），随后交给子类清理内存缓存 */
  async disconnect(localUserId: string): Promise<void> {
    await this.authorization.clear(localUserId)
    this.onDisconnected()
  }

  /** 断开后的内存缓存清理钩子（无内存缓存的源无需覆写） */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  protected onDisconnected(): void {}

  /** 进度上报（无回调时静默） */
  protected report(
    onProgress: ((progress: TProgress) => void) | undefined,
    phase: TProgress['phase'],
    percent: number,
    message: string,
    extra?: Partial<TProgress>
  ): void {
    onProgress?.({ phase, percent, message, ...extra } as TProgress)
  }
}
