import { EventEmitter } from 'events'
import { join } from 'path'
import { homedir } from 'os'
import type { Database } from 'better-sqlite3'
import type { WorkMode } from '../mode/work-mode'
import type { IConfigRepository } from './interfaces/IConfigRepository'
import type { IAuthRepository } from './interfaces/IAuthRepository'
import { LocalDataSource } from './local/LocalDataSource'
import { LocalConfigRepository } from './local/LocalConfigRepository'
import { LocalAuthRepository } from './local/LocalAuthRepository'
import { WorkspaceRepository } from '../workspace/WorkspaceRepository'
import { CloudDataSource, type CloudTokenStore } from './cloud/CloudDataSource'
import { CloudAuthRepository } from './cloud/CloudAuthRepository'
import { CloudConfigRepository } from './cloud/CloudConfigRepository'

/**
 * 数据源工厂（单例 + 工厂 + 观察者）
 * 按当前工作模式创建对应的 Repository 实现（Strategy）
 */
export class DataSourceFactory {
  private static instance: DataSourceFactory | null = null

  private mode: WorkMode = 'local'
  private localDbPath = join(homedir(), '.ke-work', 'ke-work.db')
  private localMigrationsDir: string | undefined
  private localDataSource: LocalDataSource | null = null
  private cloudDataSource: CloudDataSource | null = null
  private cloudBaseUrl = ''
  private readonly emitter = new EventEmitter()

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): DataSourceFactory {
    if (!DataSourceFactory.instance) {
      DataSourceFactory.instance = new DataSourceFactory()
    }
    return DataSourceFactory.instance
  }

  /** 测试用：重置单例 */
  static resetForTest(): void {
    DataSourceFactory.instance = null
  }

  /** 运行时配置（应用启动时调用） */
  configure(options: { localDbPath?: string; localMigrationsDir?: string; cloudBaseUrl?: string }): void {
    if (options.localDbPath) this.localDbPath = options.localDbPath
    if (options.localMigrationsDir) this.localMigrationsDir = options.localMigrationsDir
    if (options.cloudBaseUrl) this.cloudBaseUrl = options.cloudBaseUrl
  }

  getMode(): WorkMode {
    return this.mode
  }

  /** 切换工作模式并通知订阅者 */
  setMode(mode: WorkMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.emitter.emit('mode:changed', mode)
  }

  onModeChanged(listener: (mode: WorkMode) => void): () => void {
    this.emitter.on('mode:changed', listener)
    return () => this.emitter.off('mode:changed', listener)
  }

  /** 注入云端 token 提供器（登录后设置） */
  setCloudTokenStore(store: CloudTokenStore): void {
    this.getCloudDataSource().setTokenStore(store)
  }

  /** 注入云端 401 刷新回调（返回 true 表示刷新成功） */
  setCloudUnauthorizedHandler(handler: () => Promise<boolean>): void {
    this.getCloudDataSource().setUnauthorizedHandler(handler)
  }

  getCloudDataSource(): CloudDataSource {
    if (!this.cloudDataSource) {
      if (!this.cloudBaseUrl) {
        throw new Error('cloudBaseUrl not configured. Call configure({ cloudBaseUrl }) first.')
      }
      this.cloudDataSource = new CloudDataSource({ baseUrl: this.cloudBaseUrl })
    }
    return this.cloudDataSource
  }

  // ── Repository 工厂方法（Strategy）──

  createConfigRepository(): IConfigRepository {
    return this.mode === 'local'
      ? new LocalConfigRepository(this.getLocalDataSource())
      : new CloudConfigRepository(this.getCloudDataSource())
  }

  createAuthRepository(): IAuthRepository {
    if (this.mode === 'local') {
      return new LocalAuthRepository(this.getLocalDataSource())
    }
    if (!this.cloudBaseUrl) {
      // cloud 模式未配置 CLOUD_API_BASE_URL 时降级本地实现，避免应用启动崩溃；
      // 登录流程（本地密码 / OAuth2 账号关联）本身就走本地仓库
      console.warn(
        '[data-source] cloud mode without CLOUD_API_BASE_URL, fallback to local auth repository'
      )
      return new LocalAuthRepository(this.getLocalDataSource())
    }
    return new CloudAuthRepository(this.getCloudDataSource())
  }

  /** 本地认证仓库（OAuth2 账号关联始终写本地 users/oauth2_sessions，与工作模式无关） */
  createLocalAuthRepository(): IAuthRepository {
    return new LocalAuthRepository(this.getLocalDataSource())
  }

  /** 工作空间仓储（机器级资源，与工作模式无关，复用本地连接） */
  createWorkspaceRepository(): WorkspaceRepository {
    return new WorkspaceRepository(this.getLocalDataSource().getDb())
  }

  /** 本地数据库连接（会话自定义标题等业务表使用；cloud 模式同样落本地） */
  getLocalDb(): Database.Database {
    return this.getLocalDataSource().getDb()
  }

  private getLocalDataSource(): LocalDataSource {
    if (!this.localDataSource) {
      this.localDataSource = new LocalDataSource(this.localDbPath, this.localMigrationsDir)
    }
    return this.localDataSource
  }

  /** 释放资源（应用退出/测试清理时调用） */
  close(): void {
    this.localDataSource?.close()
    this.localDataSource = null
    this.cloudDataSource = null
  }
}
