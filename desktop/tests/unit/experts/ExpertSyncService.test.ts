import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AxiosInstance } from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { describe, expect, it, vi } from 'vitest'
import { ExpertSyncService } from '../../../src/main/experts/ExpertSyncService'
import { ExpertJsonStore } from '../../../src/main/experts/ExpertJsonStore'
import type { ISecureStorage } from '../../../src/main/security/secure-storage'
import type { DesktopExpert, ExpertSyncProgress } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-expert-sync-'))
}

function createSecureStorage(): ISecureStorage {
  const map = new Map<string, string>()
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value)
    },
    delete: (key) => {
      map.delete(key)
    }
  }
}

function makeSyncItem(id = 'e1'): Record<string, unknown> {
  return {
    id,
    name: `专家${id}`,
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
    expertise_areas: []
  }
}

function makeExpert(id = 'e1'): DesktopExpert {
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
    isExpert: true
  }
}

interface ServiceHarness {
  service: ExpertSyncService
  mock: MockAdapter
}

function setup(expertsDir: string): ServiceHarness {
  const service = new ExpertSyncService({
    secureStorage: createSecureStorage(),
    openExternal: async () => undefined,
    expertsDir
  })
  const http = (service as unknown as { http: AxiosInstance }).http
  const mock = new MockAdapter(http)
  const oauth2 = {
    ensureValidAccessToken: vi.fn(async () => 'access-token'),
    getStatus: vi.fn(() => ({
      status: 'authorized',
      webUser: { id: 'u1', nickname: 'demo', avatar: null }
    })),
    revoke: vi.fn(async () => undefined),
    deleteToken: vi.fn(),
    loadToken: vi.fn(() => null)
  }
  ;(service as unknown as { oauth2: unknown }).oauth2 = oauth2
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
})
