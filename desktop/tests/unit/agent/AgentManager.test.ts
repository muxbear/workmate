import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const createDeepAgentMock = vi.fn()
const { initChatModelMock } = vi.hoisted(() => ({ initChatModelMock: vi.fn() }))

vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>()
  return { ...actual, initChatModel: initChatModelMock }
})

vi.mock('deepagents', () => ({
  createDeepAgent: (config: unknown) => {
    createDeepAgentMock(config)
    return { id: 'mock-agent', dispose: vi.fn().mockResolvedValue(undefined) }
  },
  FilesystemBackend: class {
    constructor(public opts: unknown) {}
  },
  LocalShellBackend: class {
    constructor(public opts: unknown) {}
  },
  StoreBackend: class {
    constructor(public opts: unknown) {}
  },
  CompositeBackend: class {
    constructor(
      public defaultBackend: unknown,
      public routes: Record<string, unknown>
    ) {}
  }
}))
vi.mock('@langchain/langgraph-checkpoint-sqlite', () => ({
  SqliteSaver: class {
    static fromConnString(path: string) {
      return { kind: 'SqliteSaver', path }
    }
  }
}))
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: class {
    static fromConnString() {
      return { kind: 'PostgresSaver' }
    }
  }
}))
vi.mock('@langchain/langgraph-checkpoint-postgres/store', () => ({
  PostgresStore: class {
    static fromConnString() {
      return { kind: 'PostgresStore', setup: async () => {} }
    }
    async setup() {}
  }
}))

vi.mock('../../../src/main/agent/SqliteStore', () => ({
  SqliteStore: class {
    static fromConnString(path: string) {
      return { kind: 'SqliteStore', path }
    }
  }
}))

import { AgentManager } from '../../../src/main/agent/AgentManager'

/** 假 ModelService（断言中间件注册用；getCredential 无实际调用） */
function createFakeModelService(): {
  getCredential: ReturnType<typeof vi.fn>
  list: () => never[]
  listProviders: () => never[]
} {
  return {
    getCredential: vi.fn().mockImplementation((id: string) =>
      id === 'deepseek-v4-pro'
        ? {
            id,
            name: id,
            apiKey: 'sk-test',
            url: 'https://api.deepseek.com/chat/completions'
          }
        : null
    ),
    list: () => [],
    listProviders: () => []
  }
}

describe('AgentManager', () => {
  let workDir: string
  let manager: AgentManager

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kw-am-'))
    createDeepAgentMock.mockClear()
    initChatModelMock.mockClear()
    initChatModelMock.mockResolvedValue({ id: 'mock-model' })
    manager = new AgentManager(workDir, join(workDir, 'ke-work.db'), join(workDir, 'ke-work.db'))
  })

  it('AG-06a: init 后 ready 返回 agent 实例', async () => {
    await manager.init('local')
    const agent = await manager.ready()
    expect(agent).not.toBeNull()
  })

  it('AG-06b: 模式切换重建 agent，保留自定义配置', async () => {
    process.env.CLOUD_POSTGRES_CONN_STRING = 'postgres://mock'
    await manager.init('local')
    const first = await manager.ready()
    manager.setModel('deepseek:deepseek-v4-pro').setSkills(['/skills/'])
    await manager.switchMode('cloud')
    delete process.env.CLOUD_POSTGRES_CONN_STRING
    const second = await manager.ready()
    expect(second).not.toBe(first)
    // setSkills 现在会触发重建（修复「只写 builder 不重建」），最后一次 build 即 cloud 实例
    const config = createDeepAgentMock.mock.calls.at(-1)?.[0] as Record<string, never>
    expect(config.model).toBe('deepseek:deepseek-v4-pro')
    expect((config.checkpointer as { kind: string }).kind).toBe('PostgresSaver')
  })

  it('AG-06c: switchMode 后 getCheckpointer 指向新实例', async () => {
    process.env.CLOUD_POSTGRES_CONN_STRING = 'postgres://mock'
    await manager.init('local')
    const localCp = manager.getCheckpointer()
    expect((localCp as unknown as { kind: string }).kind).toBe('SqliteSaver')
    await manager.switchMode('cloud')
    delete process.env.CLOUD_POSTGRES_CONN_STRING
    const cloudCp = manager.getCheckpointer()
    expect((cloudCp as unknown as { kind: string }).kind).toBe('PostgresSaver')
    expect(cloudCp).not.toBe(localCp)
  })

  it('AG-07: 未 init 时 switchMode 抛错', async () => {
    await expect(manager.switchMode('cloud')).rejects.toThrow(/not initialized/i)
  })

  it('AG-08: 注入 modelService 后 build 注册模型覆盖中间件（config.middleware 含 modelOverrideMiddleware）', async () => {
    const withService = new AgentManager(
      workDir,
      join(workDir, 'ke-work.db'),
      join(workDir, 'ke-work.db'),
      createFakeModelService() as never
    )
    await withService.init('local')
    const config = createDeepAgentMock.mock.calls[0][0] as Record<string, never>
    const middleware = config.middleware as { name?: string }[]
    expect(Array.isArray(middleware)).toBe(true)
    expect(middleware).toHaveLength(1)
    expect(middleware[0].name).toBe('modelOverrideMiddleware')
    // 模式切换重建同样带中间件（保留自定义配置）
    await withService.switchMode('cloud')
    const config2 = createDeepAgentMock.mock.calls[1][0] as Record<string, never>
    expect((config2.middleware as { name?: string }[])[0].name).toBe('modelOverrideMiddleware')
    // 注入 modelService 后，默认模型应在 build 前解析为模型实例
    expect(config.model).toEqual({ id: 'mock-model' })
    expect(config2.model).toEqual({ id: 'mock-model' })
    expect(initChatModelMock).toHaveBeenCalledWith('deepseek-v4-pro', {
      modelProvider: 'openai',
      apiKey: 'sk-test',
      configuration: { baseURL: 'https://api.deepseek.com' }
    })
  })

  it('AG-10: applyInstalledSkills 重建 agent 并携带 /skills/<dir>/ 技能源', async () => {
    const withSkills = new AgentManager(
      workDir,
      join(workDir, 'ke-work.db'),
      join(workDir, 'ke-work.db'),
      undefined,
      { skillsDir: join(workDir, 'skills') }
    )
    await withSkills.init('local')
    await withSkills.applyInstalledSkills(['web-search'])
    const config = createDeepAgentMock.mock.calls.at(-1)?.[0] as Record<string, never>
    expect(config.skills).toEqual(['/skills/web-search/'])
  })

  it('AG-09: 未注入 modelService 时不注册中间件（config.middleware 缺失）', async () => {
    await manager.init('local')
    const config = createDeepAgentMock.mock.calls[0][0] as Record<string, never>
    expect(config.middleware).toBeUndefined()
  })

  it('P2: setExperts 专家集合未变化时跳过重建，集合变化才重建', async () => {
    await manager.init('local')
    const afterInit = createDeepAgentMock.mock.calls.length

    const expert = {
      id: 'expert-1',
      name: '文档写作专家',
      title: '文档写作专家',
      tags: [],
      desc: '',
      color: '',
      icon: '',
      category: 'content_creation',
      rating: 0,
      users: '0',
      initials: '文',
      systemPrompt: '',
      tools: [],
      capabilities: ['document.assemble'],
      providerId: null,
      modelId: null,
      modelName: null,
      modelType: null,
      skills: [],
      mcpConfigs: [],
      promptTemplate: '',
      expertiseAreas: [],
      isExpert: true
    } as never

    await manager.setExperts([expert])
    const afterFirst = createDeepAgentMock.mock.calls.length
    expect(afterFirst).toBe(afterInit + 1)

    // 同一批专家（会话连续多轮对话）：复用已构建的 agent
    await manager.setExperts([expert])
    expect(createDeepAgentMock.mock.calls.length).toBe(afterFirst)

    // 集合变化：重建
    await manager.setExperts([])
    expect(createDeepAgentMock.mock.calls.length).toBe(afterFirst + 1)
  })

  it('P1-10: 专家 MCP 服务加载失败时回传告警（含专家名），供渲染层提示', async () => {
    await manager.init('local')

    const expert = {
      id: 'expert-video',
      name: '视频创作专家',
      title: '视频创作专家',
      tags: [],
      desc: '',
      color: '',
      icon: '',
      category: 'content_creation',
      rating: 0,
      users: '0',
      initials: '视',
      systemPrompt: '你是视频创作专家',
      tools: [],
      skills: [],
      providerId: null,
      modelId: null,
      modelName: null,
      modelType: null,
      // 指向一个必然连不上的地址，触发 MCP 加载失败
      mcpConfigs: [
        {
          mcpToolId: 'mcp-video',
          mcpToolName: 'AI 视频生成',
          transport: 'streamable_http',
          url: '',
          sseUrl: '',
          streamableHttpUrl: 'http://127.0.0.1:59999/mcp/video-gen-http/mcp',
          config: {},
          enabled: true
        }
      ],
      promptTemplate: '',
      expertiseAreas: [],
      isExpert: true
    } as never

    const result = await manager.setExperts([expert])
    expect(result.mcpWarnings.length).toBeGreaterThan(0)
    expect(result.mcpWarnings[0].toolName).toContain('视频创作专家')
    expect(result.mcpWarnings[0].toolName).toContain('AI 视频生成')
    expect(result.mcpWarnings[0].url).toContain('video-gen-http/mcp')

    // 同一批专家复用已构建的 agent 时，告警仍应回传（否则用户只在第一轮看到提示）
    const again = await manager.setExperts([expert])
    expect(again.mcpWarnings).toHaveLength(result.mcpWarnings.length)
  }, 30_000)
})
