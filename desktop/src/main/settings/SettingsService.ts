import { join } from 'path'
import { homedir } from 'os'
import { isAbsolute } from 'path'
import type { SettingsStore } from './SettingsStore'
import { isSettingsKey, isValidSettingsValue } from './schema'
import { getDiskUsage, type StorageStats } from './DiskUsageService'

export type ProxyMode = 'direct' | 'system' | 'manual'
export type ThemeName = 'light' | 'dark'

/** 外部效果依赖（index.ts 装配注入；可注入便于测试） */
export interface SettingsServiceDeps {
  /** 应用主题（nativeTheme.themeSource 同步） */
  applyTheme: (theme: ThemeName) => void
  /** 应用代理（session.setProxy 封装） */
  applyProxy: (mode: ProxyMode, url: string) => Promise<void>
  /** 锁屏远程（powerSaveBlocker 封装） */
  setLockScreen: (enabled: boolean) => void
  /** 系统目录选择对话框（取消返回 null） */
  selectDir: () => Promise<string | null>
  /** 打开目录（shell.openPath） */
  openPath: (p: string) => Promise<void>
  /**
   * 默认工作空间目录变更通知：
   * 实现方负责把旧目录内容迁移到新目录并更新 workspaces 记录，
   * 迁移成功返回后 SettingsService 才持久化新值。
   */
  onDefaultWorkspaceDirChange: (dir: string) => Promise<void>
}

export interface SettingsMeta {
  /** ~/.ke-work 基础目录 */
  dataBaseDir: string
  /** 默认工作空间目录（settings 为空时 = ~/KeWork 目录本身） */
  defaultWorkspaceDir: string
}

/** 默认工作空间目录默认值（与 WorkspaceService 构造默认一致） */
export const DEFAULT_WORKSPACE_DIR = join(homedir(), 'KeWork')

/**
 * 系统设置业务服务：
 * - getAll：默认值合并后的扁平快照 + meta（供 UI 显示真实值）
 * - set：白名单 + 类型/枚举校验（主进程校验权威）→ 持久化 → 按 key 分发效果
 * - 默认工作空间路径：先迁移目录再持久化，失败不改写配置
 * - 存储统计 / 目录选择 / 打开数据目录
 */
export class SettingsService {
  constructor(
    private readonly store: SettingsStore,
    private readonly dataBaseDir: string,
    private readonly deps: SettingsServiceDeps
  ) {}

  /** 当前生效的默认工作空间目录（设置值；为空时回退默认 ~/KeWork） */
  getDefaultWorkspaceDir(): string {
    return (this.store.get('workspace.defaultWorkspaceDir') as string) || DEFAULT_WORKSPACE_DIR
  }

  getAll(): { settings: Record<string, unknown>; meta: SettingsMeta } {
    const settings = this.store.getAll() as unknown as Record<string, unknown>
    return {
      settings,
      meta: { dataBaseDir: this.dataBaseDir, defaultWorkspaceDir: this.getDefaultWorkspaceDir() }
    }
  }

  /**
   * 校验 → 持久化 → 按 key 分发效果（代理/锁屏/主题/默认工作空间目录即时生效）。
   * 默认工作空间路径走目录迁移流程：迁移成功后才持久化。
   */
  async set(key: string, value: unknown): Promise<void> {
    if (!isSettingsKey(key)) throw new Error('未知设置项: ' + String(key))
    if (!isValidSettingsValue(key, value)) {
      throw new Error('设置值非法: ' + key + '=' + JSON.stringify(value))
    }
    if (key === 'workspace.defaultWorkspaceDir') {
      await this.applyDefaultWorkspaceDirChange(value as string)
      return
    }
    this.store.set(key, value)

    switch (key) {
      case 'network.proxyMode':
      case 'network.proxyUrl': {
        const mode = this.store.get('network.proxyMode') as ProxyMode
        const url = this.store.get('network.proxyUrl') as string
        void this.deps
          .applyProxy(mode, url)
          .catch((err) => console.warn('[settings] applyProxy failed:', err))
        break
      }
      case 'lockScreen.remoteLock':
        this.deps.setLockScreen(value === true)
        break
      case 'ui.theme':
        this.deps.applyTheme(value as ThemeName)
        break
    }
  }

  /** 默认工作空间路径变更：先迁移（含目录与 workspaces 记录），成功后落库 */
  private async applyDefaultWorkspaceDirChange(dir: string): Promise<void> {
    const resolved = typeof dir === 'string' && dir.trim() ? dir.trim() : DEFAULT_WORKSPACE_DIR
    if (!isAbsolute(resolved)) throw new Error('默认工作空间路径必须为绝对路径')
    if (resolved === this.getDefaultWorkspaceDir()) return
    await this.deps.onDefaultWorkspaceDirChange(resolved)
    this.store.set(
      'workspace.defaultWorkspaceDir',
      typeof dir === 'string' && dir.trim() ? resolved : ''
    )
  }

  /** ~/.ke-work 目录占用真实统计 + 磁盘容量（设置页打开时请求） */
  getStorageStats(): Promise<StorageStats> {
    return getDiskUsage(this.dataBaseDir)
  }

  /** 系统目录选择对话框 → 校验绝对路径 → 迁移旧默认目录 → 持久化新路径 */
  async selectWorkspaceDir(): Promise<string | null> {
    const dir = await this.deps.selectDir()
    if (!dir) return null
    if (!isAbsolute(dir)) throw new Error('路径必须为绝对路径')
    await this.set('workspace.defaultWorkspaceDir', dir)
    return dir
  }

  /** 打开 ~/.ke-work 数据目录 */
  openDataDir(): Promise<void> {
    return this.deps.openPath(this.dataBaseDir)
  }
}
