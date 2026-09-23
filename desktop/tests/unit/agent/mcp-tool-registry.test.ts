import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP 加载失败必须"可见"：否则专家本地工具为 0 时，子智能体会静默退化成
 * 没有任何工具的纯文本模型，用户完全看不出原因（方案 P1-10）。
 */
const { connect, loadMcpTools } = vi.hoisted(() => ({
  connect: vi.fn(),
  loadMcpTools: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connect
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(public url: unknown) {}
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: unknown) {}
  }
}))
vi.mock('@langchain/mcp-adapters', () => ({ loadMcpTools }))

const { buildExpertMcpTools } = await import('../../../src/main/agent/tools/McpToolRegistry')

/**
 * 构造一份 MCP 配置。
 *
 * `host` 用于隔离模块级客户端缓存（成功连接会按地址缓存，跨用例复用会串味）。
 */
function makeConfig(host = 'video-gen', overrides: Record<string, unknown> = {}) {
  return {
    mcpToolId: `mcp-${host}`,
    mcpToolName: 'AI 视频生成',
    transport: 'streamable_http',
    url: '',
    sseUrl: '',
    streamableHttpUrl: `http://127.0.0.1:8001/mcp/${host}-http/mcp`,
    config: {},
    enabled: true,
    ...overrides
  }
}

describe('buildExpertMcpTools（加载失败上报）', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue(undefined)
    loadMcpTools.mockReset().mockResolvedValue([])
  })

  it('服务连不上时通过 onError 上报，且不抛异常影响智能体构建', async () => {
    connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8001'))
    const failures: Array<{ toolName: string; url: string; message: string }> = []

    const tools = await buildExpertMcpTools([makeConfig('refused')], {
      onError: (failure) => failures.push(failure)
    })

    expect(tools).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0].toolName).toBe('AI 视频生成')
    expect(failures[0].url).toBe('http://127.0.0.1:8001/mcp/refused-http/mcp')
    expect(failures[0].message).toContain('ECONNREFUSED')
  })

  it('加载成功时不上报，且返回工具', async () => {
    loadMcpTools.mockResolvedValue([{ name: 'generate_video' }])
    const onError = vi.fn()

    const tools = await buildExpertMcpTools([makeConfig('ok')], { onError })

    expect(tools).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('未启用或缺少地址的配置被跳过，不误报', async () => {
    const onError = vi.fn()
    await buildExpertMcpTools(
      [
        makeConfig('disabled', { enabled: false }),
        makeConfig('nourl', { streamableHttpUrl: '', sseUrl: '', url: '' })
      ],
      { onError }
    )
    expect(onError).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('多个服务失败时逐个上报', async () => {
    connect.mockRejectedValue(new Error('boom'))
    const onError = vi.fn()

    await buildExpertMcpTools(
      [
        makeConfig('multi-a'),
        makeConfig('multi-b', { mcpToolName: 'AI 图像生成' })
      ],
      { onError }
    )

    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls.map((c) => c[0].toolName)).toEqual(['AI 视频生成', 'AI 图像生成'])
  })
})
