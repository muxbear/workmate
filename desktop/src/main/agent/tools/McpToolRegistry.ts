import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadMcpTools } from '@langchain/mcp-adapters'
import type { DynamicStructuredTool } from '@langchain/core/tools'
import type { DesktopMcpConfig } from '../../../preload/index.d'

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

async function getMcpClient(cfg: DesktopMcpConfig): Promise<Client> {
  const endpoint = resolveEndpoint(cfg)
  if (!endpoint) {
    throw new Error(`MCP 工具「${cfg.mcpToolName || cfg.mcpToolId}」缺少连接地址`)
  }
  const cached = mcpClients.get(endpoint.key)
  if (cached) return cached

  const client = new Client({ name: 'ke-work-desktop', version: '1.0.0' }, { capabilities: {} })
  const transport =
    endpoint.kind === 'http'
      ? new StreamableHTTPClientTransport(new URL(endpoint.url))
      : new SSEClientTransport(new URL(endpoint.url))

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, endpoint.url)
  mcpClients.set(endpoint.key, client)
  return client
}

/** Resolve per-tool timeout (ms): explicit config > env var > service default. */
function resolveToolTimeoutMs(cfg: DesktopMcpConfig): number {
  const configuredMs = readPositiveNumber(cfg.config?.toolTimeoutMs ?? cfg.config?.timeout, 0)
  if (configuredMs > 0) return configuredMs

  const envMs = readPositiveNumber(process.env.MCP_TOOL_TIMEOUT_MS, 0)
  if (envMs > 0) return envMs

  const isImageGen = [cfg.streamableHttpUrl, cfg.sseUrl, cfg.url].some((url) =>
    url.includes('image-gen')
  )
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

/**
 * 从专家的 MCP 配置加载工具并注册为专家子智能体工具。
 *
 * 优先使用 Streamable HTTP，其次 SSE；任一服务连接失败只记录警告并跳过，
 * 不会阻塞智能体构建（桌面端 MCP 服务不可用时专家退化为无联网工具）。
 */
export async function buildExpertMcpTools(mcpConfigs: unknown[]): Promise<DynamicStructuredTool[]> {
  if (!Array.isArray(mcpConfigs) || mcpConfigs.length === 0) return []

  const tools: DynamicStructuredTool[] = []
  for (const raw of mcpConfigs) {
    const cfg = normalizeMcpConfig(raw)
    if (!cfg || !cfg.enabled) continue
    try {
      const client = await getMcpClient(cfg)
      const loaded = await loadMcpTools(cfg.mcpToolName || 'mcp', client, {
        defaultToolTimeout: resolveToolTimeoutMs(cfg)
      })
      tools.push(...loaded)
      console.log(
        `[mcp-tools] 专家 MCP 工具「${cfg.mcpToolName}」已加载：${loaded.map((t) => t.name).join('、')}`
      )
    } catch (error) {
      console.warn(`[mcp-tools] 加载专家 MCP 工具「${cfg.mcpToolName}」失败，已跳过：`, error)
    }
  }
  return tools
}
