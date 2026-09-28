/**
 * MCP 建连的 OAuth2 鉴权：只对本平台后端的 MCP 端点携带 access token。
 *
 * 背景：云端知识库检索由服务端 MCP 服务提供，调用方身份**只能**来自请求头
 * `Authorization: Bearer <access token>`。桌面端此前建连不带任何凭据，
 * 服务端只好按「缺少身份信息」拒绝——专家里的知识库工具因此形同虚设。
 *
 * 三条约束（每条都对应一个真实失败模式）：
 *
 * 1. **只给本平台后端的 MCP 端点发凭据**：专家同步下来的 `mcp_configs` 也可能
 *    指向第三方 MCP 服务，把本平台 token 发过去等于泄露凭据；
 * 2. **token 按请求现取，而不是建连时固定一次**：access token 有效期 2 小时，
 *    而 MCP 客户端是按 URL 长期缓存的（`mcpClients`），写死在 transport 上
 *    会在两小时后变成一个必然失败的连接；
 * 3. **取 token 不触发交互式授权**：建连发生在智能体构建这类后台路径上，
 *    弹浏览器窗口既突兀又会卡住构建。缺授权就不带 token，由服务端明确拒绝
 *    （其错误载荷里已写明该去哪儿开启权限），用户主动操作时再走授权。
 */

/** 取一枚可用 access token；取不到返回 null（调用方据此不带凭据建连） */
export interface McpAuthContext {
  getAccessToken(): Promise<string | null>
  /** 丢弃缓存并复位失败状态（登出、撤销授权后调用） */
  invalidate(): void
  /** 最近一次未取到 token 的原因；成功或无尝试时为 null */
  getLastFailure(): McpAuthFailure | null
}

/** 未取到 token 的原因：供上层区分"没授权"与"取 token 失败" */
export interface McpAuthFailure {
  code: 'auth-required' | 'auth-failed'
  message: string
}

/** 允许携带凭据的源集合 */
export interface PlatformMcpPolicy {
  readonly allowedOrigins: ReadonlySet<string>
}

/** 回环地址的三种写法：`127.0.0.1` / `localhost` / `[::1]` 互不同源，但等价 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const

/** 归一化 origin；入参非法时返回 null（不抛错——判定失败一律按"不放行"处理） */
export function normalizeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * 组装允许源集合。
 *
 * @param apiBaseUrl 平台后端 API 基址（`OAuth2ClientService.getApiBaseUrl()`）
 * @param mcpPublicBaseUrl 部署到远端时后端下发的 MCP 公共基址
 *   （环境变量 `WORKMATE_MCP_PUBLIC_BASE_URL`，需与后端 `MCP_PUBLIC_BASE_URL` 一致）
 */
export function buildPlatformMcpPolicy(deps: {
  apiBaseUrl: string
  mcpPublicBaseUrl?: string
}): PlatformMcpPolicy {
  const origins = new Set<string>()
  for (const raw of [deps.apiBaseUrl, deps.mcpPublicBaseUrl]) {
    if (!raw) continue
    const origin = normalizeOrigin(raw)
    if (origin) origins.add(origin)
  }
  // 补回环别名：后端下发的地址与本地 API 基址可能一个写 localhost、一个写 127.0.0.1
  for (const origin of [...origins]) {
    if (!isLoopbackOrigin(origin)) continue
    const url = new URL(origin)
    for (const host of LOOPBACK_HOSTS)
      origins.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`)
  }
  return { allowedOrigins: origins }
}

/**
 * 是否属于"可以向其发送本平台凭据"的 MCP 端点。
 *
 * 判定：http(s) 协议 + 允许源 + 路径在 `/mcp/` 下（后端内置 MCP 全部挂在这里）。
 * 远端源**必须走 https**——否则 token 会以明文上线，宁可漏注入也不误注入。
 */
export function isPlatformMcpEndpoint(rawUrl: string, policy: PlatformMcpPolicy): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!url.pathname.startsWith('/mcp/')) return false
  if (!policy.allowedOrigins.has(url.origin)) return false
  return isLoopbackOrigin(url.origin) || url.protocol === 'https:'
}

/** MCP SDK 的 `FetchLike` 结构（此处不依赖 SDK 类型，便于单测直接构造） */
export type AuthedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/** MCP 客户端建连时需要的最小门面：判定端点 + 取凭据 + 报告失败原因 */
export interface McpAuthBinding {
  /** 该端点是否属于本平台（需要且允许携带凭据） */
  applies(url: string): boolean
  /** 该端点的带凭据 fetch；不属于平台端点时返回 null */
  fetchFor(url: string): AuthedFetch | null
  /** 取一枚可用 token（建连前探测）；取不到返回 null，原因见 getLastFailure() */
  probe(): Promise<string | null>
  getLastFailure(): McpAuthFailure | null
  invalidate(): void
}

export function createMcpAuthBinding(deps: {
  auth: McpAuthContext
  policy: PlatformMcpPolicy
}): McpAuthBinding {
  const authedFetch = createAuthedFetch(deps.auth)
  const applies = (url: string): boolean => isPlatformMcpEndpoint(url, deps.policy)
  return {
    applies,
    fetchFor: (url) => (applies(url) ? authedFetch : null),
    probe: () => deps.auth.getAccessToken(),
    getLastFailure: () => deps.auth.getLastFailure(),
    invalidate: () => deps.auth.invalidate()
  }
}

/**
 * 构造"每次请求现取 token"的 fetch。
 *
 * 用自定义 fetch 而不是 `requestInit.headers`：后者在构造 transport 时就固化了
 * （SDK 内部 `createFetchWithInit`），配长连接缓存必然过期。
 * 取不到 token 时**原样透传**——降级为无凭据请求，由服务端给出可读拒绝。
 */
export function createAuthedFetch(
  auth: McpAuthContext,
  baseFetch: AuthedFetch = fetch
): AuthedFetch {
  return async (url, init) => {
    const token = await auth.getAccessToken()
    if (!token) return baseFetch(url, init)
    // 保留 SDK 自己的头（Accept / mcp-protocol-version 等），只加 Authorization
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return baseFetch(url, { ...init, headers })
  }
}

export interface McpTokenProviderDeps {
  /** 统一授权提供者（缺 scope 判断、刷新单飞都在它里面） */
  authorization: {
    hasScopes(localUserId: string, required: readonly string[]): boolean
    /** 非交互取 token：取不到返回 null，**绝不触发授权**（见 OAuth2AuthorizationProvider） */
    tryEnsureAccessToken(localUserId: string, required: readonly string[]): Promise<string | null>
  }
  /** 当前本地用户（未登录返回 null） */
  session: { getCurrentUserId(): string | null }
  /** 注入 token 所需的 scope；缺省为知识库读权限（当前唯一需要身份的内置 MCP 服务） */
  requiredScopes?: readonly string[]
}

/**
 * 给 MCP 取 token：**只在已授权时取**，绝不触发交互式授权。
 *
 * 当前只有云知识库检索这一个内置 MCP 服务需要调用方身份（其余内置服务不做
 * 按用户授权），所以统一以 `knowledge:read` 作为注入开关：授予了就带上 token，
 * 没授予就降级为无凭据连接——用户主动去「授权管理」开启后即可生效。
 */
export class McpTokenProvider implements McpAuthContext {
  private readonly requiredScopes: readonly string[]
  private failure: McpAuthFailure | null = null
  /** 并发合流：一次请求期间只取一次 token */
  private inFlight: Promise<string | null> | null = null

  constructor(private readonly deps: McpTokenProviderDeps) {
    this.requiredScopes = deps.requiredScopes ?? ['knowledge:read']
  }

  async getAccessToken(): Promise<string | null> {
    const userId = this.deps.session.getCurrentUserId()
    if (!userId) {
      this.failure = null
      return null
    }
    if (!this.deps.authorization.hasScopes(userId, this.requiredScopes)) {
      this.failure = {
        code: 'auth-required',
        message: `需要授予「${this.requiredScopes.join('、')}」后才能使用该服务：请在 设置 - 账号 - 授权管理 中开启`
      }
      return null
    }
    if (!this.inFlight) {
      this.inFlight = this.load(userId).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  invalidate(): void {
    this.failure = null
    this.inFlight = null
  }

  getLastFailure(): McpAuthFailure | null {
    return this.failure
  }

  private async load(userId: string): Promise<string | null> {
    // 走到这里说明 hasScopes 已通过；用 tryEnsureAccessToken 而**不是** ensureAccessToken：
    // 后者在 refresh 失效时会 clear + 重新授权（弹浏览器），而建连是后台路径。
    const token = await this.deps.authorization.tryEnsureAccessToken(userId, this.requiredScopes)
    if (!token) {
      const message = '刷新访问凭据失败，请重新登录或到授权管理中重新开启权限'
      console.warn('[mcp-auth] 静默取 access token 失败，本次连接不带凭据')
      this.failure = { code: 'auth-failed', message }
      return null
    }
    this.failure = null
    return token
  }
}
