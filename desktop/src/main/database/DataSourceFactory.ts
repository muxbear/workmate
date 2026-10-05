import { join } from 'path'
import { homedir } from 'os'
import type { Database } from 'better-sqlite3'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { ILocalAuthStore } from './interfaces/ILocalAuthStore'
import { LocalDataSource } from './local/LocalDataSource'
import { LocalAuthRepository } from './local/LocalAuthRepository'
import { WorkspaceRepository } from '../workspace/WorkspaceRepository'
import { ConversationStore } from '../agent/ConversationStore'
import { AutomationRepository } from '../automation/AutomationRepository'
import { AutomationRunRepository } from '../automation/AutomationRunRepository'
import { AuditLogRepository } from '../automation/AuditLogRepository'

/**
 * 数据源工厂（单例 + 工厂）
 *
 * **R8-3 瘦身**：
 * - 工作模式不再由本工厂持有 —— 单一事实源 = `WorkModeStore`（工厂内叠放的
 *   `mode`/`setMode`/`onModeChanged`/`mode:changed` 死事件与双写一并删除）；
 * - 未接线的云端 Repository 链（`getCloudDataSource` / `CloudConfigRepository` /
 *   `createConfigRepository` / cloud token 注入）整条删除 —— 桌面端云端身份走
 *   OAuth2、云知识库走 CloudKnowledgeService HTTP，全链零生产消费者
 *   （P3-5 方法级普查结论；按方案 §1.2「没有第二个真实消费者的抽象不做」）。
 * - 留守职责：本地连接（惰性打开 + 迁移目录）与按域 create* 构造。
 */
export class DataSourceFactory {
  private static instance: DataSourceFactory | null = null

  private localDbPath = join(homedir(), '.ke-work', 'ke-work.db')
  private localMigrationsDir: string | undefined
  private localDataSource: LocalDataSource | null = null

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
  configure(options: { localDbPath?: string; localMigrationsDir?: string }): void {
    if (options.localDbPath) this.localDbPath = options.localDbPath
    if (options.localMigrationsDir) this.localMigrationsDir = options.localMigrationsDir
  }

  /** 本地认证存储（登录凭据校验与 OAuth2 账号关联始终写本地 users/oauth2_sessions，与工作模式无关） */
  createLocalAuthRepository(): ILocalAuthStore {
    return new LocalAuthRepository(this.getLocalDataSource())
  }

  /** 工作空间仓储（机器级资源，与工作模式无关，复用本地连接） */
  createWorkspaceRepository(): WorkspaceRepository {
    return new WorkspaceRepository(this.getLocalDataSource().getDb())
  }

  /** 会话存储（checkpointer 由装配层注入；自定义标题等业务表走本地连接） */
  createConversationStore(getCheckpointer: () => BaseCheckpointSaver): ConversationStore {
    return new ConversationStore(getCheckpointer, () => this.getLocalDb())
  }

  /** 自动化任务仓储（本地库，按用户隔离） */
  createAutomationRepository(): AutomationRepository {
    return new AutomationRepository(this.getLocalDb())
  }

  /** 自动化运行记录仓储（本地库） */
  createAutomationRunRepository(): AutomationRunRepository {
    return new AutomationRunRepository(this.getLocalDb())
  }

  /** 自动化审计日志仓储（本地库） */
  createAuditLogRepository(): AuditLogRepository {
    return new AuditLogRepository(this.getLocalDb())
  }

  /** 本地数据库连接（R8-1 收回：仅供本工厂内 create* 构造使用，不再对外泄漏） */
  private getLocalDb(): Database.Database {
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
  }
}
