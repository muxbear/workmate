import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AxiosInstance } from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { describe, expect, it, vi } from 'vitest'
import { ExpertSyncService } from '../../../src/main/experts/ExpertSyncService'
import { ExpertJsonStore } from '../../../src/main/experts/ExpertJsonStore'
import type { OAuth2AuthorizationProvider } from '../../../src/main/oauth2/OAuth2AuthorizationProvider'
import type { DesktopExpert, ExpertSyncProgress } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-expert-sync-'))
}

/** 统一授权提供者替身（专家同步只用到这几个方法） */
function fakeAuthorization(): OAuth2AuthorizationProvider {
  const webUser = { id: 'u1', nickname: 'demo' }
  return {
    getSnapshot: vi.fn(() => ({
      status: 'authorized',
      webUser,
      grantedScopes: ['expert:read'],
      missingScopes: []
    })),
    getWebUser: vi.fn(() => webUser),
    ensureAuthorization: vi.fn(async () => ({ grantedScopes: ['expert:read'] })),
    ensureAccessToken: vi.fn(async () => 'access-token'),
    clear: vi.fn(async () => undefined)
  } as unknown as OAuth2AuthorizationProvider
}

function makeSyncItem(id = 'e1', version = '1.0.0', name?: string): Record<string, unknown> {
  return {
    id,
    name: name ?? `专家${id}`,
    title: `标题${id}`,
    desc: '描述',
    category: 'custom',
    tags: [],
    color: '',
    initials: '专',
    icon: '',
    avatar_url: null,
    rating: 4.8,
    users: '1k',
    system_prompt: '',
    scene: null,
    sort_order: 0,
    provider_id: null,
    model_id: null,
    model_name: null,
    model_type: null,
    tools: [],
    skills: [],
    mcp_configs: [],
    prompt_template: '',
    expertise_areas: [],
    version
  }
}

function makeExpert(id = 'e1', version?: string): DesktopExpert {
  return {
    id,
    name: `专家${id}`,
    title: `标题${id}`,
    tags: [],
    desc: '描述',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    icon: 'Zap',
    category: 'custom',
    rating: 4.8,
    users: '1k',
    initials: '专',
    systemPrompt: '',
    tools: [],
    providerId: null,
    modelId: null,
    modelName: null,
    modelType: null,
    skills: [],
    mcpConfigs: [],
    promptTemplate: '',
    expertiseAreas: [],
    ...(version ? { version } : {}),
    isExpert: true
  }
}

interface ServiceHarness {
  service: ExpertSyncService
  mock: MockAdapter
}

function setup(expertsDir: string): ServiceHarness {
  const service = new ExpertSyncService({
    authorization: fakeAuthorization(),
    expertsDir
  })
  const http = (service as unknown as { http: AxiosInstance }).http
  const mock = new MockAdapter(http)
  return { service, mock }
}

describe('ExpertSyncService', () => {
  it('ESS-01: sync 拉取 → 落盘 → 读回，进度按阶段单调递增', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: { items: [makeSyncItem('e1')], total: 1, synced_at: 123 },
      message: 'ok'
    })

    const phases: ExpertSyncProgress['phase'][] = []
    const percents: number[] = []
    const result = await service.sync('local-user', (p) => {
      phases.push(p.phase)
      percents.push(p.percent)
    })

    expect(result.experts).toHaveLength(1)
    expect(result.experts[0]?.id).toBe('e1')
    expect(phases).toEqual(['authorize', 'fetch', 'save', 'load', 'done'])
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
    }

    const raw = JSON.parse(readFileSync(join(dir, 'experts.json'), 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(raw.experts).toHaveLength(1)
    expect(raw.experts[0].id).toBe('e1')

    const disk = await service.loadLocal()
    expect(disk?.experts[0]?.id).toBe('e1')
    expect(typeof disk?.syncedAt).toBe('number')
  })

  it('ESS-02: 拉取失败时不覆盖已有本地文件', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('old')]
    })
    mock.onGet('/api/expert-sync/list').reply(500, {
      code: 500,
      data: null,
      message: '服务器错误'
    })

    await expect(service.sync('local-user')).rejects.toThrow('服务器错误')
    const raw = JSON.parse(readFileSync(join(dir, 'experts.json'), 'utf-8'))
    expect(raw.experts[0].id).toBe('old')
    expect(raw.syncedAt).toBe(111)
  })

  it('ESS-03: 无本地文件时 loadLocal 返回 null', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await expect(service.loadLocal()).resolves.toBeNull()
  })

  it('ESS-04: 服务端版本更高 → 用服务端内容覆盖本地并计入 updated', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1', '1.0.0')]
    })
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: { items: [makeSyncItem('e1', '1.0.1', '服务端专家')], total: 1, synced_at: 123 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 1, kept: 0 })
    expect(result.experts[0]?.name).toBe('服务端专家')
    expect(result.experts[0]?.version).toBe('1.0.1')
  })

  it('ESS-05: 本地版本更高 → 保留本地内容并计入 kept', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1', '9.9.9')]
    })
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: { items: [makeSyncItem('e1', '1.0.1', '服务端专家')], total: 1, synced_at: 123 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 0, kept: 1 })
    // 本地更高：内容与版本都保持本地，不被服务端回退
    expect(result.experts[0]?.name).toBe('专家e1')
    expect(result.experts[0]?.version).toBe('9.9.9')
  })

  it('ESS-06: 版本相同 → 保留本地条目（不重复覆盖），新增条目计入 added', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1', '1.0.0')]
    })
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: {
        items: [makeSyncItem('e1', '1.0.0'), makeSyncItem('e2', '1.0.0')],
        total: 2,
        synced_at: 123
      },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 1, updated: 0, kept: 1 })
    expect(result.experts.map((expert) => expert.id)).toEqual(['e1', 'e2'])
  })

  it('ESS-07: 本地老数据无版本 → 视为需要更新并补上服务端版本号', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1')]
    })
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: { items: [makeSyncItem('e1', '1.0.1', '服务端专家')], total: 1, synced_at: 123 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 1, kept: 0 })
    expect(result.experts[0]?.version).toBe('1.0.1')
    expect(result.experts[0]?.name).toBe('服务端专家')
  })

  it('ESS-08: 服务端未返回版本（老服务端）→ 保留本地版本与内容', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1', '1.0.0')]
    })
    const item = makeSyncItem('e1', '')
    delete item.version
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: { items: [item], total: 1, synced_at: 123 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 0, kept: 1 })
    expect(result.experts[0]?.version).toBe('1.0.0')
  })

  it('ESS-09: deleteExpert 只移除目标专家，其余条目与同步时间不变', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: { webUserId: 'u1', nickname: 'demo' },
      experts: [makeExpert('e1', '1.0.0'), makeExpert('e2', '1.0.0')]
    })

    const result = await service.deleteExpert('e1')

    expect(result.experts.map((expert) => expert.id)).toEqual(['e2'])
    expect(result.syncedAt).toBe(111)
    const raw = JSON.parse(readFileSync(join(dir, 'experts.json'), 'utf-8'))
    expect(raw.experts.map((expert: { id: string }) => expert.id)).toEqual(['e2'])
    expect(raw.syncedAt).toBe(111)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
  })

  it('ESS-10: 删除本地专家后再次同步 → 该专家按服务端版本重新拉回', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1', '1.0.0'), makeExpert('e2', '1.0.0')]
    })
    mock.onGet('/api/expert-sync/list').reply(200, {
      code: 0,
      data: {
        items: [makeSyncItem('e1', '1.0.0'), makeSyncItem('e2', '1.0.0')],
        total: 2,
        synced_at: 123
      },
      message: 'ok'
    })

    await service.deleteExpert('e1')
    await expect(service.loadLocal()).resolves.toMatchObject({
      experts: [expect.objectContaining({ id: 'e2' })]
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 1, updated: 0, kept: 1 })
    expect(result.experts.map((expert) => expert.id)).toEqual(['e1', 'e2'])
  })

  it('ESS-11: deleteExpert 本地文件缺失或专家不存在时报错', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await expect(service.deleteExpert('e1')).rejects.toThrow('本地专家数据不存在，请先同步')

    await new ExpertJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      experts: [makeExpert('e1')]
    })
    await expect(service.deleteExpert('missing')).rejects.toThrow('专家不存在，请先同步专家数据')
    // 报错时不得改动本地文件
    const raw = JSON.parse(readFileSync(join(dir, 'experts.json'), 'utf-8'))
    expect(raw.experts).toHaveLength(1)
  })
})
