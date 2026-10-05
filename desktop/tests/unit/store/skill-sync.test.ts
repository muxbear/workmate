import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCatalogStore } from '../../../src/renderer/src/store/catalog'
import { useSkillSyncStore } from '../../../src/renderer/src/store/skillSync'
import { createSyncMockApi, type SyncMockApi } from './sync-mock-api'
import type { DesktopSkill, SkillInstallProgress } from '../../../src/shared/contracts'

function makeSkill(id: string, overrides: Partial<DesktopSkill> = {}): DesktopSkill {
  return {
    id,
    name: `技能${id}`,
    desc: '描述',
    category: 'custom',
    icon: 'Zap',
    color: '#0891b2',
    enabled: true,
    isBuiltin: false,
    source: 'web',
    ...overrides
  }
}

type MockFn = ReturnType<typeof vi.fn>

interface SkillMockApi extends SyncMockApi {
  install: MockFn
  uninstall: MockFn
  /** delete 通道（store 方法名为 remove） */
  delete: MockFn
  getCachedSkills: MockFn
  onInstallProgress: MockFn
  /** 手动推送一条安装进度（模拟主进程） */
  pushInstallProgress(progress: SkillInstallProgress): void
}

function installMockApi(): SkillMockApi {
  const api = createSyncMockApi()
  api.sync.mockImplementation(async () => {
    api.pushProgress({ phase: 'fetch', percent: 50, message: '拉取中' })
    return {
      success: true,
      data: {
        skills: [makeSkill('remote')],
        syncedAt: 222,
        stats: { added: 1, updated: 0, kept: 0 }
      }
    }
  })
  api.loadLocal.mockImplementation(async () => ({
    success: true,
    data: { skills: [makeSkill('local')], syncedAt: 111 }
  }))

  let installCb: ((p: SkillInstallProgress) => void) | null = null
  const full = {
    ...api,
    install: vi.fn(async (id: string) => ({
      success: true,
      data: { skill: makeSkill(id, { installed: true }) }
    })),
    uninstall: vi.fn(async (id: string) => ({
      success: true,
      data: { skill: makeSkill(id, { installed: false }) }
    })),
    delete: vi.fn(async () => ({ success: true, data: { skills: [], syncedAt: 111 } })),
    getCachedSkills: vi.fn(async () => ({ success: true, data: [] })),
    onInstallProgress: vi.fn((cb: (p: SkillInstallProgress) => void) => {
      installCb = cb
      return () => {
        installCb = null
      }
    }),
    pushInstallProgress: (progress: SkillInstallProgress) => installCb?.(progress)
  }
  vi.stubGlobal('window', { api: { skillSync: full } })
  return full
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skillSync store（薄壳：同步骨架来自 syncCore，安装流程为技能域特有）', () => {
  it('SS-01: loadLocal 读 skills.json 写入技能页', async () => {
    installMockApi()
    const store = useSkillSyncStore()
    await expect(store.loadLocal()).resolves.toBe(true)
    expect(store.lastSyncedAt).toBe(111)
    expect(useCatalogStore().skillItems.map((s) => s.id)).toEqual(['local'])
    expect(store.error).toBeNull()
  })

  it('SS-02: sync 成功写入技能列表与统计', async () => {
    installMockApi()
    const store = useSkillSyncStore()
    await store.loadStatus()
    await expect(store.sync()).resolves.toBe(true)
    expect(useCatalogStore().skillItems.map((s) => s.id)).toEqual(['remote'])
    expect(store.lastSyncedAt).toBe(222)
    expect(store.stats).toEqual({ added: 1, updated: 0, kept: 0 })
    expect(store.percent).toBe(100)
    expect(store.syncing).toBe(false)
  })

  it('SS-03: sync 失败保留旧列表并记录错误', async () => {
    const api = installMockApi()
    useCatalogStore().setSkills([makeSkill('old')])
    api.sync.mockResolvedValue({ success: false, error: '网络错误' })
    const store = useSkillSyncStore()
    store.status = 'authorized'
    await expect(store.sync()).resolves.toBe(false)
    expect(store.error).toBe('网络错误')
    expect(useCatalogStore().skillItems.map((s) => s.id)).toEqual(['old'])
  })

  it('SS-04: install 期间进度事件更新提示、成功后安装位清空；并发安装被拒绝', async () => {
    const api = installMockApi()
    // install 挂起（真实安装耗时期间才有进度事件）：手动放行以断言中间态
    let resolveInstall: (value: unknown) => void = () => {}
    api.install.mockImplementation(
      () => new Promise((resolve) => (resolveInstall = resolve))
    )
    const store = useSkillSyncStore()
    await store.loadLocal()

    const installing = store.install('local')
    expect(store.installingId).toBe('local')
    // 并发安装直接拒绝（不发起第二次 IPC）
    await expect(store.install('local')).resolves.toBe(false)
    expect(api.install).toHaveBeenCalledTimes(1)

    api.pushInstallProgress({
      skillId: 'local',
      skillName: '技能local',
      phase: 'runtime',
      percent: 60,
      message: '准备运行时'
    })
    expect(store.installMessage).toBe('准备运行时')

    resolveInstall({ success: true, data: { skill: makeSkill('local', { installed: true }) } })
    await expect(installing).resolves.toBe(true)
    expect(store.installingId).toBeNull()
    expect(useCatalogStore().skillItems[0].installed).toBe(true)
  })

  it('SS-05: remove 走删除通道并从技能页移除；失败保留并记录错误', async () => {
    const api = installMockApi()
    const store = useSkillSyncStore()
    await store.loadLocal()

    await expect(store.remove('local')).resolves.toBe(true)
    expect(api.delete).toHaveBeenCalledWith('local')
    expect(useCatalogStore().skillItems).toHaveLength(0)

    useCatalogStore().setSkills([makeSkill('keep')])
    api.delete.mockResolvedValue({ success: false, error: '删除失败' })
    await expect(store.remove('keep')).resolves.toBe(false)
    expect(store.error).toBe('删除失败')
    expect(useCatalogStore().skillItems.map((s) => s.id)).toEqual(['keep'])
    expect(store.removingId).toBeNull()
  })

  it('SS-06: resetLocal 清空共享状态、安装态与技能页', async () => {
    installMockApi()
    const store = useSkillSyncStore()
    await store.loadLocal()
    expect(useCatalogStore().skillItems).toHaveLength(1)

    store.resetLocal()

    expect(store.status).toBe('unknown')
    expect(store.lastSyncedAt).toBeNull()
    expect(store.error).toBeNull()
    expect(store.syncing).toBe(false)
    expect(store.stats).toBeNull()
    expect(store.removingId).toBeNull()
    expect(store.installingId).toBeNull()
    expect(store.installMessage).toBe('')
    expect(useCatalogStore().skillItems).toHaveLength(0)
  })
})
