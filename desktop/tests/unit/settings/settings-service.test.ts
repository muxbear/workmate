import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsStore } from '../../../src/main/settings/SettingsStore'
import {
  DEFAULT_WORKSPACE_DIR,
  SettingsService,
  type SettingsServiceDeps
} from '../../../src/main/settings/SettingsService'

let baseDir: string
let store: SettingsStore
let deps: SettingsServiceDeps

function createDeps(): SettingsServiceDeps {
  return {
    applyTheme: vi.fn(),
    applyProxy: vi.fn().mockResolvedValue(undefined),
    setLockScreen: vi.fn(),
    selectDir: vi.fn().mockResolvedValue(null),
    openPath: vi.fn().mockResolvedValue(undefined),
    onDefaultWorkspaceDirChange: vi.fn().mockResolvedValue(undefined)
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'ke-service-'))
  store = new SettingsStore(baseDir)
  deps = createDeps()
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('SettingsService', () => {
  it('getAll：默认值合并 + meta（defaultWorkspaceDir 为空时 = ~/KeWork 目录本身）', () => {
    const service = new SettingsService(store, baseDir, deps)
    const { settings, meta } = service.getAll()
    expect(settings['ui.language']).toBe('zh-CN')
    expect(meta.dataBaseDir).toBe(baseDir)
    expect(meta.defaultWorkspaceDir).toBe(DEFAULT_WORKSPACE_DIR)
  })

  it('getAll：meta.defaultWorkspaceDir 反映已设置的默认工作空间路径', () => {
    store.set('workspace.defaultWorkspaceDir', 'D:\\KeWork')
    const service = new SettingsService(store, baseDir, deps)
    expect(service.getAll().meta.defaultWorkspaceDir).toBe('D:\\KeWork')
  })

  it('set：网络代理分发 applyProxy（manual + url）', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await service.set('network.proxyMode', 'manual')
    await service.set('network.proxyUrl', 'http://127.0.0.1:7890')
    expect(deps.applyProxy).toHaveBeenLastCalledWith('manual', 'http://127.0.0.1:7890')
  })

  it('set：锁屏远程分发 setLockScreen', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await service.set('lockScreen.remoteLock', true)
    expect(deps.setLockScreen).toHaveBeenCalledWith(true)
    await service.set('lockScreen.remoteLock', false)
    expect(deps.setLockScreen).toHaveBeenCalledWith(false)
  })

  it('set：主题分发 applyTheme', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await service.set('ui.theme', 'dark')
    expect(deps.applyTheme).toHaveBeenLastCalledWith('dark')
    await service.set('ui.theme', 'light')
    expect(deps.applyTheme).toHaveBeenLastCalledWith('light')
  })

  it('set：默认工作空间路径先迁移成功再持久化（空值回退默认目录）', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await service.set('workspace.defaultWorkspaceDir', 'D:\\KeWork2')
    expect(deps.onDefaultWorkspaceDirChange).toHaveBeenCalledWith('D:\\KeWork2')
    expect(store.get('workspace.defaultWorkspaceDir')).toBe('D:\\KeWork2')
    await service.set('workspace.defaultWorkspaceDir', '')
    expect(deps.onDefaultWorkspaceDirChange).toHaveBeenCalledWith(DEFAULT_WORKSPACE_DIR)
    expect(store.get('workspace.defaultWorkspaceDir')).toBe('')
  })

  it('set：默认空间路径迁移失败时不持久化新值', async () => {
    deps.onDefaultWorkspaceDirChange = vi.fn().mockRejectedValue(new Error('迁移失败'))
    const service = new SettingsService(store, baseDir, deps)
    await expect(service.set('workspace.defaultWorkspaceDir', 'D:\\NewDir')).rejects.toThrow(
      '迁移失败'
    )
    expect(store.get('workspace.defaultWorkspaceDir')).toBe('')
  })

  it('set：白名单/校验拒绝（未知 key 与非法值抛错，不写库不分发）', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await expect(service.set('bogus', 1)).rejects.toThrow()
    await expect(service.set('ui.language', 'fr-FR')).rejects.toThrow()
    expect(deps.applyProxy).not.toHaveBeenCalled()
  })

  it('selectWorkspaceDir：用户取消返回 null', async () => {
    const service = new SettingsService(store, baseDir, deps)
    expect(await service.selectWorkspaceDir()).toBeNull()
    expect(store.get('workspace.defaultWorkspaceDir')).toBe('')
  })

  it('selectWorkspaceDir：选择绝对路径 → 迁移成功 → 持久化', async () => {
    deps.selectDir = vi.fn().mockResolvedValue('D:\\MyWork')
    const service = new SettingsService(store, baseDir, deps)
    expect(await service.selectWorkspaceDir()).toBe('D:\\MyWork')
    expect(store.get('workspace.defaultWorkspaceDir')).toBe('D:\\MyWork')
    expect(deps.onDefaultWorkspaceDirChange).toHaveBeenCalledWith('D:\\MyWork')
  })

  it('selectWorkspaceDir：相对路径拒绝', async () => {
    deps.selectDir = vi.fn().mockResolvedValue('relative/dir')
    const service = new SettingsService(store, baseDir, deps)
    await expect(service.selectWorkspaceDir()).rejects.toThrow()
  })

  it('getStorageStats：返回目录统计（真实目录）', async () => {
    const service = new SettingsService(store, baseDir, deps)
    const stats = await service.getStorageStats()
    expect(stats.baseDir).toBe(baseDir)
    expect(stats.usedBytes).toBeGreaterThanOrEqual(0)
    expect(stats.diskTotal).toBeGreaterThan(0)
    expect(stats.diskFree).toBeGreaterThan(0)
  })

  it('openDataDir：转发 openPath', async () => {
    const service = new SettingsService(store, baseDir, deps)
    await service.openDataDir()
    expect(deps.openPath).toHaveBeenCalledWith(baseDir)
  })
})
