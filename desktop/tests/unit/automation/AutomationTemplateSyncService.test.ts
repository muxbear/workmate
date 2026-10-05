import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AxiosInstance } from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { describe, expect, it, vi } from 'vitest'
import { AutomationTemplateSyncService } from '../../../src/main/automation/AutomationTemplateSyncService'
import { AutomationTemplateJsonStore } from '../../../src/main/automation/AutomationTemplateJsonStore'
import type { OAuth2AuthorizationProvider } from '../../../src/main/oauth2/OAuth2AuthorizationProvider'
import type {
  AutomationSchedule,
  AutomationTemplateSyncProgress,
  DesktopAutomationTemplate
} from '../../../src/shared/contracts'

const ENDPOINT = '/api/automation-template-sync/list'

function createBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kw-template-sync-'))
}

/** 统一授权提供者替身（模板同步只用到这几个方法） */
function fakeAuthorization(): OAuth2AuthorizationProvider {
  const webUser = { id: 'u1', nickname: 'demo' }
  return {
    getSnapshot: vi.fn(() => ({
      status: 'authorized',
      webUser,
      grantedScopes: ['template:read'],
      missingScopes: []
    })),
    getWebUser: vi.fn(() => webUser),
    ensureAuthorization: vi.fn(async () => ({ grantedScopes: ['template:read'] })),
    ensureAccessToken: vi.fn(async () => 'access-token'),
    clear: vi.fn(async () => undefined)
  } as unknown as OAuth2AuthorizationProvider
}

const SCHEDULE: AutomationSchedule = {
  freqGroup: 'cycle',
  cycleKind: 'daily',
  intervalKind: 'hourly',
  onceDate: '',
  onceTime: '08:00',
  weekDays: [1],
  monthDay: 1,
  yearMonth: 1,
  yearDay: 1,
  weekIntervalDays: [1],
  hourInterval: 2,
  validityMode: 'forever',
  validFrom: '',
  validFromTime: '00:00',
  validTo: '',
  validToTime: '23:59'
}

/** 服务端 camelCase 模板条目（AutomationTemplateResponse） */
function makeSyncItem(
  id = 't1',
  version = '1.0.0',
  name?: string
): Record<string, unknown> {
  return {
    id,
    name: name ?? `模板${id}`,
    description: '描述',
    icon: '⏰',
    category: 'work',
    version,
    promptText: '提示词',
    promptParts: [{ type: 'text', text: '提示词' }],
    schedule: SCHEDULE,
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    model: null,
    customModelId: null,
    providerId: null,
    modelId: null,
    expertId: null,
    expertName: null,
    contextMode: 'default',
    skillIds: [],
    kbIds: [],
    workspaceId: null,
    workspaceName: null,
    allowNetwork: false,
    allowShell: false,
    fullAccess: false,
    createdAt: 1,
    updatedAt: 2
  }
}

function makeTemplate(id = 't1', version?: string): DesktopAutomationTemplate {
  return {
    id,
    name: `模板${id}`,
    description: '描述',
    icon: '⏰',
    category: 'work',
    version: version ?? '1.0.0',
    promptText: '提示词',
    promptParts: [{ type: 'text', text: '提示词' }],
    schedule: SCHEDULE,
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    model: null,
    customModelId: null,
    expertId: null,
    expertName: null,
    contextMode: 'default',
    skillIds: [],
    workspaceId: null,
    workspaceName: null,
    fullAccess: false,
    providerId: null,
    modelId: null,
    kbIds: [],
    allowNetwork: false,
    allowShell: false,
    createdAt: 1,
    updatedAt: 2
  }
}

interface ServiceHarness {
  service: AutomationTemplateSyncService
  mock: MockAdapter
}

function setup(templatesDir: string): ServiceHarness {
  const service = new AutomationTemplateSyncService({
    authorization: fakeAuthorization(),
    templatesDir
  })
  const http = (service as unknown as { http: { axiosInstance: AxiosInstance } }).http.axiosInstance
  const mock = new MockAdapter(http)
  return { service, mock }
}

describe('AutomationTemplateSyncService', () => {
  it('ATS-01: sync 拉取 → 落盘 → 读回，进度按阶段单调递增', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: { items: [makeSyncItem('t1')], total: 1, page: 1, page_size: 100 },
      message: 'ok'
    })

    const phases: AutomationTemplateSyncProgress['phase'][] = []
    const percents: number[] = []
    const result = await service.sync('local-user', (p) => {
      phases.push(p.phase)
      percents.push(p.percent)
    })

    expect(result.templates).toHaveLength(1)
    expect(result.templates[0]?.id).toBe('t1')
    expect(phases).toEqual(['authorize', 'fetch', 'save', 'load', 'done'])
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
    }

    const raw = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
    expect(raw.templates).toHaveLength(1)
    expect(raw.templates[0].id).toBe('t1')

    const disk = await service.loadLocal()
    expect(disk?.templates[0]?.id).toBe('t1')
    expect(typeof disk?.syncedAt).toBe('number')
  })

  it('ATS-02: 拉取失败时不覆盖已有本地文件', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('old')]
    })
    mock.onGet(ENDPOINT).reply(500, { code: 500, data: null, message: '服务器错误' })

    await expect(service.sync('local-user')).rejects.toThrow('服务器错误')
    const raw = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    expect(raw.templates[0].id).toBe('old')
    expect(raw.syncedAt).toBe(111)
  })

  it('ATS-03: 无本地文件时 loadLocal 返回 null', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await expect(service.loadLocal()).resolves.toBeNull()
  })

  it('ATS-04: 服务端版本更高 → 覆盖本地并计入 updated', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('t1', '1.0.0')]
    })
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: { items: [makeSyncItem('t1', '1.0.1', '服务端模板')], total: 1, page: 1, page_size: 100 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 1, kept: 0 })
    expect(result.templates[0]?.name).toBe('服务端模板')
    expect(result.templates[0]?.version).toBe('1.0.1')
  })

  it('ATS-05: 本地版本更高 → 保留本地内容并计入 kept', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('t1', '9.9.9')]
    })
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: { items: [makeSyncItem('t1', '1.0.1', '服务端模板')], total: 1, page: 1, page_size: 100 },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 0, updated: 0, kept: 1 })
    expect(result.templates[0]?.name).toBe('模板t1')
    expect(result.templates[0]?.version).toBe('9.9.9')
  })

  it('ATS-06: 版本相同保留本地、新增条目计入 added', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('t1', '1.0.0')]
    })
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: {
        items: [makeSyncItem('t1', '1.0.0'), makeSyncItem('t2', '1.0.0')],
        total: 2,
        page: 1,
        page_size: 100
      },
      message: 'ok'
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 1, updated: 0, kept: 1 })
    expect(result.templates.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('ATS-07: total 超过一页时翻页取全量，不静默截断', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    const requested: number[] = []
    // 共 150 条，page_size 上限 100：第 1 页 100 条 + 第 2 页 50 条
    const all = Array.from({ length: 150 }, (_, i) => makeSyncItem(`t${i}`))
    mock.onGet(ENDPOINT).reply((config) => {
      const page = Number(config.params?.page ?? 1)
      requested.push(page)
      const start = (page - 1) * 100
      return [
        200,
        {
          code: 0,
          data: {
            items: all.slice(start, start + 100),
            total: all.length,
            page,
            page_size: 100
          },
          message: 'ok'
        }
      ]
    })

    const result = await service.sync('local-user')

    expect(requested).toEqual([1, 2])
    expect(result.templates).toHaveLength(150)
    expect(result.stats).toEqual({ added: 150, updated: 0, kept: 0 })
  })

  it('ATS-08: deleteTemplate 只移除目标模板，其余条目与同步时间不变', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: { webUserId: 'u1', nickname: 'demo' },
      templates: [makeTemplate('t1'), makeTemplate('t2')]
    })

    const result = await service.deleteTemplate('t1')

    expect(result.templates.map((t) => t.id)).toEqual(['t2'])
    expect(result.syncedAt).toBe(111)
    const raw = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf-8'))
    expect(raw.templates.map((t: { id: string }) => t.id)).toEqual(['t2'])
    expect(raw.syncedAt).toBe(111)
    expect(raw.syncedBy).toEqual({ webUserId: 'u1', nickname: 'demo' })
  })

  it('ATS-09: 删除本地模板后再次同步 → 该模板按服务端版本重新拉回', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('t1'), makeTemplate('t2')]
    })
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: {
        items: [makeSyncItem('t1'), makeSyncItem('t2')],
        total: 2,
        page: 1,
        page_size: 100
      },
      message: 'ok'
    })

    await service.deleteTemplate('t1')
    await expect(service.loadLocal()).resolves.toMatchObject({
      templates: [expect.objectContaining({ id: 't2' })]
    })

    const result = await service.sync('local-user')

    expect(result.stats).toEqual({ added: 1, updated: 0, kept: 1 })
    expect(result.templates.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('ATS-10: deleteTemplate 本地文件缺失或模板不存在时报错', async () => {
    const dir = createBaseDir()
    const { service } = setup(dir)
    await expect(service.deleteTemplate('t1')).rejects.toThrow('本地定时模板不存在，请先同步')

    await new AutomationTemplateJsonStore(dir).write({
      version: 1,
      syncedAt: 111,
      syncedBy: null,
      templates: [makeTemplate('t2')]
    })
    await expect(service.deleteTemplate('t1')).rejects.toThrow('模板不存在，请先同步定时模板')
  })

  it('ATS-11: 映射服务端条目 → 本地模板（只留文本段、files 归一为 local）', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    const item = makeSyncItem('t1')
    // 文件段在桌面端落不了地：应被丢弃；contextMode 的 files 应归一为 local
    item.promptParts = [
      { type: 'text', text: '正文' },
      { type: 'file', attachmentId: 'att-1', filename: 'a.txt' }
    ]
    item.contextMode = 'files'
    item.kbIds = ['kb-1']
    mock.onGet(ENDPOINT).reply(200, {
      code: 0,
      data: { items: [item], total: 1, page: 1, page_size: 100 },
      message: 'ok'
    })

    const result = await service.sync('local-user')
    const tpl = result.templates[0]!

    expect(tpl.promptParts).toEqual([{ type: 'text', text: '正文' }])
    expect(tpl.contextMode).toBe('local')
    // 桌面任务草稿用不到的字段仍原样落盘，便于后续对接
    expect(tpl.kbIds).toEqual(['kb-1'])
  })

  it('ATS-12: 信封 code 非 0 时抛出服务端 message', async () => {
    const dir = createBaseDir()
    const { service, mock } = setup(dir)
    mock.onGet(ENDPOINT).reply(200, { code: 403, data: null, message: 'Insufficient scope: template:read' })

    await expect(service.sync('local-user')).rejects.toThrow(
      'Insufficient scope: template:read'
    )
  })
})
