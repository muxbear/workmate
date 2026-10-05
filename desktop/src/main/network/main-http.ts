import axios, { type AxiosInstance } from 'axios'
import type { MainProxyConfig } from './main-proxy'

/**
 * 主进程统一 HTTP 客户端（方案 R8-5 的代理 Facade）。
 *
 * 背景：axios 不走 Electron session —— 只有显式传入代理解析结果才会走代理。
 * 历史实现只有嵌入 / 重排两处接入了「设置 → 网络」，其余 axios 出网
 * （OAuth2 登录、四个同步源、云数据源、云知识库、图片生成）在企业代理环境
 * 全部静默直连；Chromium 栈（net.fetch / 内嵌浏览器）则由 session.setProxy 覆盖。
 *
 * 统一后：
 * - 每个请求按目标 URL 解析代理（system 模式问 Chromium；manual 用设置地址）；
 * - 解析结果即**唯一事实源**：直连时显式 `proxy: false`，切断 axios 对
 *   环境变量（HTTP_PROXY 等）的隐式回退，与应用设置语义一致；
 * - 统一 User-Agent 与超时缺省；
 * - 错误映射不在此统一（各服务协议不同：envelope / 直通），仅提供通用
 *   `toHttpErrorMessage` 供需要 message 归一的地方复用。
 */

export type ProxyResolver = (targetUrl: string) => Promise<MainProxyConfig | undefined>

/** 组合根配置的代理解析器（进程级；按请求读取，允许客户端先于配置构造） */
let configuredProxyResolver: ProxyResolver | undefined

/** 组合根启动时一次性注入（由「设置 → 网络」驱动）；不配置 = 直连 */
export function configureMainHttpProxyResolver(resolver: ProxyResolver | undefined): void {
  configuredProxyResolver = resolver
}

export interface CreateMainHttpClientOptions {
  /** 诊断标识（代理解析告警日志中标识来源），如 'oauth2'、'web-api' */
  purpose: string
  baseURL?: string
  /** 缺省 15s（与历史各 axios.create 默认一致） */
  timeoutMs?: number
  /** 覆盖组合根配置（单测注入；缺省用全局配置） */
  resolveProxy?: ProxyResolver
}

/** 统一 User-Agent（信创 / 企业网关按客户端识别时使用） */
const MAIN_HTTP_USER_AGENT = 'KeWork-Desktop'

export function createMainHttpClient(options: CreateMainHttpClientOptions): AxiosInstance {
  const client = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? 15_000,
    headers: { 'User-Agent': MAIN_HTTP_USER_AGENT }
  })

  client.interceptors.request.use(async (config) => {
    // 调用方显式指定 proxy（对象/false）优先；未指定时按应用设置解析
    if (config.proxy !== undefined) return config
    const resolveProxy = options.resolveProxy ?? configuredProxyResolver
    if (!resolveProxy) return config
    try {
      const proxy = await resolveProxy(resolveTargetUrl(config))
      config.proxy = proxy ?? false
    } catch (err) {
      // 解析失败不阻断请求：降级直连并告警
      console.warn(`[network] ${options.purpose} 代理解析失败，按直连处理：`, err)
      config.proxy = false
    }
    return config
  })

  return client
}

/** 请求的目标地址（绝对 URL 直接用；相对路径拼 baseURL） */
function resolveTargetUrl(config: { url?: string; baseURL?: string }): string {
  const url = config.url ?? ''
  if (/^https?:\/\//i.test(url)) return url
  if (config.baseURL) {
    try {
      return new URL(url, config.baseURL).toString()
    } catch {
      // 拼不出来时原样交给解析器（system 模式会回 DIRECT）
    }
  }
  return url
}

/**
 * axios 错误 → 可读 message（兼容 message/detail 字段与 arraybuffer 错误体）。
 * 历史实现四个同步源各写一份且互有差异（只有技能源处理了 arraybuffer 错误体），此处取并集。
 */
export function toHttpErrorMessage(error: unknown, fallback = '网络请求失败'): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : fallback
  }
  const data: unknown = error.response?.data
  if (data instanceof ArrayBuffer) {
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(data))) as {
        message?: string
        detail?: string
      }
      return parsed.message || parsed.detail || error.message || fallback
    } catch {
      return error.message || fallback
    }
  }
  const record = data as { message?: string; detail?: string } | undefined
  return record?.message || record?.detail || error.message || fallback
}
