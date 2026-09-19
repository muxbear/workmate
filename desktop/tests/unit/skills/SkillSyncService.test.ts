import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AxiosInstance } from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import type { OAuth2AuthorizationProvider } from '../../../src/main/oauth2/OAuth2AuthorizationProvider'
import { hashSkillFileEntries, SkillFileStore } from '../../../src/main/skills/SkillFileStore'
import { SkillJsonStore, type SkillJsonFile } from '../../../src/main/skills/SkillJsonStore'
import { SkillSyncService } from '../../../src/main/skills/SkillSyncService'
import type { SkillSyncProgress } from '../../../src/preload/index.d'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-skill-sync-'))
}

/** 统一授权提供者替身（技能同步只用到这几个方法） */
function fakeAuthorization(): OAuth2AuthorizationProvider {
  const webUser = { id: 'u1', nickname: 'demo' }
  return {
    getSnapshot: vi.fn(() => ({
      status: 'authorized',
      webUser,
      grantedScopes: ['skill:read'],
      missingScopes: []
    })),
    getWebUser: vi.fn(() => webUser),
    ensureAuthorization: vi.fn(async () => ({ grantedScopes: ['skill:read'] })),
    ensureAccessToken: vi.fn(async () => 'access-token'),
    clear: vi.fn(async () => undefined)
  } as unknown as OAuth2AuthorizationProvider
}

function skillZip(name = 'web-search'): Uint8Array {
  const encoder = new TextEncoder()
  return zipSync({
    'SKILL.md': encoder.encode(`---\nname: ${name}\ndescription: demo skill\n---\n`),
    'scripts/run.py': encoder.encode('print(1)\n')
  })
}

const LIST_ITEM = {
  id: 's1',
  name: '网络搜索',
  description: 'demo skill',
  category: 'search',
  icon: 'Search',
  enabled: true,
  is_builtin: true,
  source: 'builtin'
}

interface Harness {
  service: SkillSyncService
  store: SkillJsonStore
  fileStore: SkillFileStore
  mock: MockAdapter
}

function setup(dir: string): Harness {
  const store = new SkillJsonStore(dir)
  const fileStore = new SkillFileStore(dir)
  const service = new SkillSyncService({
    authorization: fakeAuthorization(),
    store,
    fileStore
  })
  const http = (service as unknown as { http: AxiosInstance }).http
  return { service, store, fileStore, mock: new MockAdapter(http) }
}

function mockList(mock: MockAdapter, items: unknown[]): void {
  mock.onGet('/api/skill/list').reply(200, {
    code: 0,
    data: { items, total: items.length, page: 1, page_size: 100 },
    message: 'ok'
  })
}

function readJson(dir: string): SkillJsonFile {
  return JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf-8')) as SkillJsonFile
}

describe('SkillSyncService', () => {
  it('SSS-01: sync 下载技能包 → 落盘 → 写 skills.json，进度单调递增', async () => {
    const dir = createBaseDir()
    const { service, fileStore, mock } = setup(dir)
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))

    const phases: SkillSyncProgress['phase'][] = []
    const percents: number[] = []
    const result = await service.sync('local-user', (progress) => {
      phases.push(progress.phase)
      percents.push(progress.percent)
    })

    expect(result.stats).toEqual({ added: 1, updated: 0, unchanged: 0, failed: 0, stale: 0 })
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.dirName).toBe('web-search')
    expect(result.skills[0]?.installed).toBe(false)
    expect(fileStore.hasSkill('web-search')).toBe(true)
    expect(phases[0]).toBe('authorize')
    expect(phases.at(-1)).toBe('done')
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
    }

    const raw = readJson(dir)
    expect(raw.version).toBe(1)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(raw.skills[0]?.dirName).toBe('web-search')
  })

  it('SSS-02: manifest 指纹一致时跳过下载（unchanged）', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))
    await service.sync('local-user')

    const stored = readJson(dir)
    const hash = hashSkillFileEntries(stored.skills[0]!.files!)
    mock.resetHandlers()
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(200, {
      code: 0,
      data: {
        id: 's1',
        name: '网络搜索',
        dir_name: 'web-search',
        hash,
        files: stored.skills[0]!.files,
        updated_at: '2026-01-01T00:00:00'
      },
      message: 'ok'
    })

    const result = await service.sync('local-user')
    expect(result.stats).toEqual({ added: 0, updated: 0, unchanged: 1, failed: 0, stale: 0 })
    expect(mock.history.get.filter((req) => req.url?.endsWith('/download'))).toHaveLength(1)
  })

  it('SSS-03: 服务端已删除的技能标记 stale（不删除本地包）', async () => {
    const dir = createBaseDir()
    const { service, fileStore, mock } = setup(dir)
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))
    await service.sync('local-user')

    mock.resetHandlers()
    mockList(mock, [])
    const result = await service.sync('local-user')

    expect(result.stats.stale).toBe(1)
    expect(result.skills[0]?.stale).toBe(true)
    expect(fileStore.hasSkill('web-search')).toBe(true)
  })

  it('SSS-04: 单个技能下载失败不阻断整体，保留旧条目并计数', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))
    await service.sync('local-user')

    mock.resetHandlers()
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(500, { code: 500, data: null, message: '下载失败' })
    const result = await service.sync('local-user')

    expect(result.stats.failed).toBe(1)
    expect(result.skills[0]?.dirName).toBe('web-search')
    expect(result.skills[0]?.stale).toBe(true)
  })

  it('SSS-05: loadLocal 读回本地技能，缺失文件返回 null', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await expect(service.loadLocal()).resolves.toBeNull()

    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))
    await service.sync('local-user')

    const local = await service.loadLocal()
    expect(local?.skills[0]?.id).toBe('s1')
    expect(local?.skills[0]?.missing).toBe(false)
  })

  it('SSS-06: 本地删除后重新同步以服务端为准，技能会被重新拉回', async () => {
    const dir = createBaseDir()
    const { service, fileStore, store, mock } = setup(dir)
    mockList(mock, [LIST_ITEM])
    mock.onGet('/api/skill/s1/manifest').reply(404, { code: 404, data: null, message: '无清单' })
    mock.onGet('/api/skill/s1/download').reply(200, Buffer.from(skillZip()))
    await service.sync('local-user')
    expect(fileStore.hasSkill('web-search')).toBe(true)

    // 模拟用户在桌面端删除本地技能（服务端仍然存在该技能）
    await store.write({ version: 1, syncedAt: Date.now(), syncedBy: null, skills: [] })

    const result = await service.sync('local-user')

    expect(result.stats.added).toBe(1)
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.id).toBe('s1')
    expect(fileStore.hasSkill('web-search')).toBe(true)
    expect(readJson(dir).skills).toHaveLength(1)
  })
})
