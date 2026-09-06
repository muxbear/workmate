import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { experts } from '../../../src/renderer/src/store/catalog'
import { useExpertSyncStore } from '../../../src/renderer/src/store/expertSync'
import type { DesktopExpert, ExpertSyncProgress } from '../../../src/preload/index.d'

function makeExpert(id: string): DesktopExpert {
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

type MockFn = ReturnType<typeof vi.fn>

function installMockApi(): {
  getStatus: MockFn
  authorize: MockFn
  sync: MockFn
  loadLocal: MockFn
  disconnect: MockFn
  onSyncProgress: MockFn
} {
  let progressCb: ((p: ExpertSyncProgress) => void) | null = null
  const getStatus = vi.fn(async () => ({
    success: true,
    data: { status: 'authorized', webUser: { id: 'u1', nickname: 'demo', avatar: null } }
  }))
  const authorize = vi.fn(async () => ({
    success: true,
    data: { webUser: { id: 'u1', nickname: 'demo', avatar: null } }
  }))
  const sync = vi.fn(async () => {
    progressCb?.({ phase: 'fetch', percent: 50, message: '拉取中' })
    progressCb?.({ phase: 'done', percent: 100, message: '完成' })
    return {
      success: true,
      data: { experts: [makeExpert('remote')], syncedAt: 222 }
    }
  })
  const loadLocal = vi.fn(async () => ({
    success: true,
    data: { experts: [makeExpert('local')], syncedAt: 111 }
  }))
  const disconnect = vi.fn(async () => ({ success: true, data: null }))
  const onSyncProgress = vi.fn((cb: (p: ExpertSyncProgress) => void) => {
    progressCb = cb
    return () => {
      progressCb = null
    }
  })
  vi.stubGlobal('window', {
    api: {
      expert: { getStatus, authorize, sync, loadLocal, disconnect, onSyncProgress }
    }
  })
  return { getStatus, authorize, sync, loadLocal, disconnect, onSyncProgress }
}

beforeEach(() => {
  setActivePinia(createPinia())
  experts.value = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('expertSync store', () => {
  it('ES-01: loadLocal 读 experts.json 并写入专家广场', async () => {
    installMockApi()
    const store = useExpertSyncStore()
    await store.loadLocal()
    expect(store.lastSyncedAt).toBe(111)
    expect(experts.value.map((e) => e.id)).toEqual(['local'])
    expect(store.error).toBeNull()
  })

  it('ES-02: sync 成功后展示远程数据并回到空闲态', async () => {
    const mock = installMockApi()
    const store = useExpertSyncStore()
    await store.loadStatus()
    const ok = await store.sync()
    expect(ok).toBe(true)
    expect(mock.onSyncProgress).toHaveBeenCalledTimes(1)
    expect(experts.value.map((e) => e.id)).toEqual(['remote'])
    expect(store.lastSyncedAt).toBe(222)
    expect(store.percent).toBe(100)
    expect(store.syncing).toBe(false)
  })

  it('ES-03: sync 失败时保留旧列表并展示错误', async () => {
    const mock = installMockApi()
    experts.value = [makeExpert('old')]
    mock.sync.mockResolvedValue({ success: false, error: '网络错误' })
    const store = useExpertSyncStore()
    store.status = 'authorized'
    const ok = await store.sync()
    expect(ok).toBe(false)
    expect(store.error).toBe('网络错误')
    expect(store.percent).toBe(0)
    expect(store.syncing).toBe(false)
    expect(experts.value.map((e) => e.id)).toEqual(['old'])
  })

  it('ES-04: 未授权时 sync 先走授权流程', async () => {
    const mock = installMockApi()
    mock.getStatus.mockResolvedValue({
      success: true,
      data: { status: 'unauthorized', webUser: null }
    })
    const store = useExpertSyncStore()
    await store.loadStatus()
    await store.sync()
    expect(mock.authorize).toHaveBeenCalledTimes(1)
    expect(store.status).toBe('authorized')
  })

  it('ES-05: resetLocal 清空状态与专家列表', async () => {
    installMockApi()
    const store = useExpertSyncStore()
    await store.loadLocal()
    expect(experts.value).toHaveLength(1)
    store.resetLocal()
    expect(experts.value).toHaveLength(0)
    expect(store.status).toBe('unknown')
    expect(store.lastSyncedAt).toBeNull()
    expect(store.error).toBeNull()
    expect(store.syncing).toBe(false)
  })
})
