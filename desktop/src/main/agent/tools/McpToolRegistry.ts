import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadMcpTools } from '@langchain/mcp-adapters'
import type { DynamicStructuredTool } from '@langchain/core/tools'
import type { DesktopMcpConfig } from '../../../preload/index.d'
import type { McpAuthBinding, McpAuthFailure } from '../../oauth2/mcpAuth'

/** MCP 连接超时（毫秒） */
const CONNECT_TIMEOUT_MS = 8_000
/** MCP 工具单次调用超时（毫秒） */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

/**
 * AI image generation tools need a longer per-call timeout.
 * Backend IMAGE_GEN_TIMEOUT_SECONDS defaults to 180s; keep this above it
 * so the client does not abort first with MCP error -32001.
 */
const IMAGE_GEN_TOOL_TIMEOUT_MS = 240_000

/**
 * AI video generation tools need an even longer per-call timeout.
 * Backend video_gen_server 的默认等待上限 VIDEO_GEN_TIMEOUT_SECONDS 为 240s；
 * 客户端超时需高于服务端，避免视频任务仍在轮询时被 MCP error -32001 提前掐断。
 */
/** 视频生成：比后端等待窗（VIDEO_GEN_TIMEOUT_SECONDS，默认 300s）多留 30s 网络余量 */
const VIDEO_GEN_TOOL_TIMEOUT_MS = 330_000

/** 按服务地址缓存已连接的 MCP 客户端，避免每次重建智能体重复建连 */
const mcpClients = new Map<string, Client>()

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 连接超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function resolveEndpoint(
  cfg: DesktopMcpConfig
): { key: string; url: string; kind: 'http' | 'sse' } | null {
  if (cfg.streamableHttpUrl) {
    return { key: `http:${cfg.streamableHttpUrl}`, url: cfg.streamableHttpUrl, kind: 'http' }
  }
  if (cfg.sseUrl) {
    return { key: `sse:${cfg.sseUrl}`, url: cfg.sseUrl, kind: 'sse' }
  }
  if (cfg.url) {
    return { key: `sse:${cfg.url}`, url: cfg.url, kind: 'sse' }
  }
  return null
}

async function getMcpClient(cfg: DesktopMcpConfig, mcpAuth?: McpAuthBinding): Promise<Client> {
  const endpoint = resolveEndpoint(cfg)
  if (!endpoint) {
    throw new Error(`MCP 工具「${cfg.mcpToolName || cfg.mcpToolId}」缺少连接地址`)
  }
  const cached = mcpClients.get(endpoint.key)
  if (cached) return cached

  // 凭据按请求现取（自定义 fetch），不写进 requestInit：后者在构造 transport 时就固化了，
  // 而客户端是按 URL 长期缓存的——写死必然在 access token 过期后变成坏连接。
  const authedFetch = mcpAuth?.fetchFor(endpoint.url) ?? null
  const transportOptions = authedFetch ? { fetch: authedFetch } : undefined

  const client = new Client({ name: 'ke-work-desktop', version: '1.0.0' }, { capabilities: {} })
  const transport =
    endpoint.kind === 'http'
      ? new StreamableHTTPClientTransport(new URL(endpoint.url), transportOptions)
      : new SSEClientTransport(new URL(endpoint.url), transportOptions)

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, endpoint.url)
  mcpClients.set(endpoint.key, client)
  return client
}

/**
 * 关闭并清空缓存的 MCP 客户端。
 *
 * 缓存按地址复用（跨智能体构建），但**身份是按人变化的**：登出或撤销授权后
 * 必须丢弃，否则下一个用户会复用到上一个用户建立的会话。
 */
export function resetMcpClients(): void {
  for (const client of mcpClients.values()) {
    client.close().catch((error) => {
      console.warn('[mcp-tools] 关闭缓存的 MCP 客户端失败（忽略）：', error)
    })
  }
  mcpClients.clear()
}

/** Resolve per-tool timeout (ms): explicit config > env var > service default. */
function resolveToolTimeoutMs(cfg: DesktopMcpConfig): number {
  const configuredMs = readPositiveNumber(cfg.config?.toolTimeoutMs ?? cfg.config?.timeout, 0)
  if (configuredMs > 0) return configuredMs

  const envMs = readPositiveNumber(process.env.MCP_TOOL_TIMEOUT_MS, 0)
  if (envMs > 0) return envMs

  const urls = [cfg.streamableHttpUrl, cfg.sseUrl, cfg.url]
  if (urls.some((url) => url.includes('video-gen'))) return VIDEO_GEN_TOOL_TIMEOUT_MS

  const isImageGen = urls.some((url) => url.includes('image-gen'))
  return isImageGen ? IMAGE_GEN_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback
}

function normalizeMcpConfig(raw: unknown): DesktopMcpConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const cfg = raw as Record<string, unknown>
  const mcpToolId = typeof cfg.mcpToolId === 'string' ? cfg.mcpToolId : ''
  const mcpToolName = typeof cfg.mcpToolName === 'string' ? cfg.mcpToolName : ''
  const transport = typeof cfg.transport === 'string' ? cfg.transport : ''
  const url = typeof cfg.url === 'string' ? cfg.url : ''
  const sseUrl = typeof cfg.sseUrl === 'string' ? cfg.sseUrl : ''
  const streamableHttpUrl = typeof cfg.streamableHttpUrl === 'string' ? cfg.streamableHttpUrl : ''
  const enabled = cfg.enabled !== false
  const config =
    typeof cfg.config === 'object' && cfg.config !== null
      ? (cfg.config as Record<string, unknown>)
      : {}
  if (!mcpToolId || (!url && !sseUrl && !streamableHttpUrl)) return null
  return { mcpToolId, mcpToolName, transport, url, sseUrl, streamableHttpUrl, config, enabled }
}

/** MCP 加载失败信息（供上层提示用户，避免"专家静默失去能力"） */
export interface McpLoadFailure {
  /** MCP 服务名（如「AI 视频生成」） */
  toolName: string
  /** 服务地址（便于排查是不是回环地址连不上） */
  url: string
  /** 失败原因 */
  message: string
  /**
   * 失败类别：缺授权时上层要给出"去开启权限"的动作，而不是笼统的连不上。
   * 缺省视为 `connect-failed`（历史调用方只需读 message）。
   */
  code?: 'connect-failed' | 'auth-required' | 'auth-failed'
}

export interface BuildExpertMcpToolsOptions {
  /** 单个 MCP 服务加载失败时回调（上层汇总后提示用户） */
  onError?: (failure: McpLoadFailure) => void
  /**
   * OAuth2 凭据绑定（见 ``main/oauth2/mcpAuth``）。
   * 只有本平台后端的 MCP 端点会被注入凭据；缺省时不注入，行为与历史版本一致。
   */
  mcpAuth?: McpAuthBinding
}

/**
 * 平台内 MCP 端点缺凭据时返回失败信息；不需要凭据或凭据可用时返回 null。
 *
 * 注意：这类服务的连接**本身会成功**（拒绝发生在工具调用层，由服务端返回结构化错误），
 * 所以不能靠"连不上"来发现问题——必须在建连前显式探测一次凭据。
 */
async function probeAuthFailure(
  endpoint: { url: string } | null,
  mcpAuth?: McpAuthBinding
): Promise<McpAuthFailure | null> {
  if (!mcpAuth || !endpoint || !mcpAuth.applies(endpoint.url)) return null
  const token = await mcpAuth.probe()
  if (token) return null
  return (
    mcpAuth.getLastFailure() ?? {
      code: 'auth-required',
      message: '需要先登录并授权本平台账号后才能使用该服务'
    }
  )
}

/**
 * 从专家的 MCP 配置加载工具并注册为专家子智能体工具。
 *
 * 优先使用 Streamable HTTP，其次 SSE；任一服务连接失败只记录警告并跳过，
 * 不会阻塞智能体构建（桌面端 MCP 服务不可用时专家退化为无联网工具）。
 *
 * 失败会通过 ``onError`` 上报：专家本地工具可能为 0，若 MCP 再静默失败，
 * 子智能体会变成"没有任何工具的纯文本模型"，用户完全看不出原因（方案 P1-10）。
 */
export async function buildExpertMcpTools(
  mcpConfigs: unknown[],
  options: BuildExpertMcpToolsOptions = {}
): Promise<DynamicStructuredTool[]> {
  if (!Array.isArray(mcpConfigs) || mcpConfigs.length === 0) return []

  const tools: DynamicStructuredTool[] = []
  for (const raw of mcpConfigs) {
    const cfg = normalizeMcpConfig(raw)
    if (!cfg || !cfg.enabled) continue

    // 平台内 MCP 端点缺凭据时**不注册**它的工具：这些工具每次调用都会被服务端按
    // "缺少身份"拒绝，挂给智能体只会制造"看起来有、用起来报错"的假能力。
    // 拒绝原因经 onError 上报，由上层提示用户去开启授权。
    const endpoint = resolveEndpoint(cfg)
    const authFailure = await probeAuthFailure(endpoint, options.mcpAuth)
    if (authFailure) {
      console.warn(`[mcp-tools] 专家 MCP 工具「${cfg.mcpToolName}」未加载：${authFailure.message}`)
      options.onError?.({
        toolName: cfg.mcpToolName || cfg.mcpToolId || 'MCP 服务',
        url: endpoint?.url ?? '',
        code: authFailure.code,
        message: authFailure.message
      })
      continue
    }

    try {
      const client = await getMcpClient(cfg, options.mcpAuth)
      const loaded = await loadMcpTools(cfg.mcpToolName || 'mcp', client, {
        defaultToolTimeout: resolveToolTimeoutMs(cfg)
      })
      tools.push(...loaded)
      console.log(
        `[mcp-tools] 专家 MCP 工具「${cfg.mcpToolName}」已加载：${loaded.map((t) => t.name).join('、')}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[mcp-tools] 加载专家 MCP 工具「${cfg.mcpToolName}」失败，已跳过：`, error)
      options.onError?.({
        toolName: cfg.mcpToolName || cfg.mcpToolId || 'MCP 服务',
        url: cfg.streamableHttpUrl || cfg.sseUrl || cfg.url,
        message
      })
    }
  }
  return tools
}
