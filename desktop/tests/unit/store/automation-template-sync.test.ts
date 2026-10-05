import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAutomationTemplateSyncStore } from '../../../src/renderer/src/store/automationTemplateSync'
import { createSyncMockApi, type SyncMockApi } from './sync-mock-api'
import type { AutomationSchedule, DesktopAutomationTemplate } from '../../../src/shared/contracts'

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

function makeTemplate(id: string): DesktopAutomationTemplate {
  return {
    id,
    name: `模板${id}`,
    description: '描述',
    icon: '⏰',
    category: 'work',
    version: '1.0.0',
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

type MockFn = ReturnType<typeof vi.fn>

type TemplateMockApi = SyncMockApi & { deleteTemplate: MockFn }

function installMockApi(): TemplateMockApi {
  const api = createSyncMockApi()
  api.sync.mockImplementation(async () => {
    api.pushProgress({ phase: 'fetch', percent: 50, message: '拉取中' })
    api.pushProgress({ phase: 'done', percent: 100, message: '完成' })
    return {
      success: true,
      data: {
        templates: [makeTemplate('remote')],
        syncedAt: 222,
        stats: { added: 1, updated: 0, kept: 0 }
      }
    }
  })
  api.loadLocal.mockImplementation(async () => ({
    success: true,
    data: { templates: [makeTemplate('local')], syncedAt: 111 }
  }))
  const deleteTemplate = vi.fn(async (id: string) => ({
    success: true,
    data: {
      templates: [makeTemplate('local')].filter((tpl) => tpl.id !== id),
      syncedAt: 111
    }
  }))
  vi.stubGlobal('window', {
    api: {
      automationTemplateSync: { ...api, deleteTemplate }
    }
  })
  return { ...api, deleteTemplate }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('automationTemplateSync store', () => {
  it('ATS-S01: loadLocal 读 templates.json 并回显列表', async () => {
    installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadLocal()
    expect(store.lastSyncedAt).toBe(111)
    expect(store.templates.map((t) => t.id)).toEqual(['local'])
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
  })

  it('ATS-S02: sync 成功后展示远程数据、记录版本比对统计并回到空闲态', async () => {
    const mock = installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadStatus()
    const ok = await store.sync()
    expect(ok).toBe(true)
    expect(mock.onSyncProgress).toHaveBeenCalledTimes(1)
    expect(store.templates.map((t) => t.id)).toEqual(['remote'])
    expect(store.lastSyncedAt).toBe(222)
    expect(store.stats).toEqual({ added: 1, updated: 0, kept: 0 })
    expect(store.percent).toBe(100)
    expect(store.syncing).toBe(false)
  })

  it('ATS-S03: sync 失败时保留旧列表并展示错误', async () => {
    const mock = installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadLocal()
    mock.sync.mockResolvedValue({ success: false, error: '网络错误' })
    store.status = 'authorized'
    const ok = await store.sync()
    expect(ok).toBe(false)
    expect(store.error).toBe('网络错误')
    expect(store.percent).toBe(0)
    expect(store.syncing).toBe(false)
    expect(store.templates.map((t) => t.id)).toEqual(['local'])
  })

  it('ATS-S04: 未授权时 sync 先走授权流程', async () => {
    const mock = installMockApi()
    mock.getStatus.mockResolvedValue({
      success: true,
      data: { status: 'unauthorized', webUser: null }
    })
    const store = useAutomationTemplateSyncStore()
    await store.loadStatus()
    await store.sync()
    expect(mock.authorize).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('authorized')
  })

  it('ATS-S05: resetLocal 清空状态与模板列表', async () => {
    installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadLocal()
    expect(store.templates).toHaveLength(1)
    store.resetLocal()
    expect(store.templates).toHaveLength(0)
    expect(store.loaded).toBe(false)
    expect(store.status).toBe('unknown')
    expect(store.lastSyncedAt).toBeNull()
    expect(store.error).toBeNull()
    expect(store.syncing).toBe(false)
    expect(store.stats).toBeNull()
    expect(store.removingId).toBeNull()
  })

  it('ATS-S06: removeTemplate 移除条目并保留「上次同步时间」不变', async () => {
    const mock = installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadLocal()

    await expect(store.removeTemplate('local')).resolves.toBe(true)

    expect(mock.deleteTemplate).toHaveBeenCalledWith('local')
    expect(store.templates).toHaveLength(0)
    // 删除不是一次同步：同步时间不应被刷新
    expect(store.lastSyncedAt).toBe(111)
    expect(store.removingId).toBeNull()
  })

  it('ATS-S07: removeTemplate 失败时保留列表并展示错误', async () => {
    const mock = installMockApi()
    const store = useAutomationTemplateSyncStore()
    await store.loadLocal()
    mock.deleteTemplate.mockResolvedValue({ success: false, error: '本地定时模板不存在，请先同步' })

    await expect(store.removeTemplate('local')).resolves.toBe(false)

    expect(store.error).toBe('本地定时模板不存在，请先同步')
    expect(store.templates.map((t) => t.id)).toEqual(['local'])
    expect(store.removingId).toBeNull()
  })
})
