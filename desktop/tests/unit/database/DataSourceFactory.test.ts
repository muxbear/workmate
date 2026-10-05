import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DataSourceFactory } from '../../../src/main/database/DataSourceFactory'

/**
 * R8-3 瘦身后的工厂表面：单例 / 本地连接 / 按域 create*。
 *
 * 工作模式已单源到 WorkModeStore（setMode/onModeChanged 与云端数据源整链删除——
 * 见 DataSourceFactory 类注释的普查结论）。本地 ConfigRepository 的用例在
 * tests/security 与 tests/integration/database 直接构造覆盖，不经本工厂。
 */
describe('DataSourceFactory（R8-3 瘦身后的表面）', () => {
  let factory: DataSourceFactory

  beforeEach(() => {
    DataSourceFactory.resetForTest()
    factory = DataSourceFactory.getInstance()
    factory.configure({ localDbPath: ':memory:' })
  })

  afterEach(() => {
    factory.close()
    DataSourceFactory.resetForTest()
  })

  it('DSF-01: 单例', () => {
    expect(DataSourceFactory.getInstance()).toBe(factory)
  })

  it('DSF-02: 认证存储始终为本地实现（与工作模式无关）', () => {
    expect(factory.createLocalAuthRepository().constructor.name).toBe('LocalAuthRepository')
  })

  it('DSF-03: 工作空间仓储复用本地连接', () => {
    expect(factory.createWorkspaceRepository().constructor.name).toBe('WorkspaceRepository')
  })

  it('DSF-04: 自动化域仓储按域构造（本地库）', () => {
    expect(factory.createAutomationRepository().constructor.name).toBe('AutomationRepository')
    expect(factory.createAutomationRunRepository().constructor.name).toBe('AutomationRunRepository')
    expect(factory.createAuditLogRepository().constructor.name).toBe('AuditLogRepository')
  })

  it('DSF-05: 会话存储经工厂构造（checkpointer 惰性注入；close 后可重建）', () => {
    factory.createConversationStore(() => ({}) as never)
    factory.close()
    expect(factory.createWorkspaceRepository()).toBeTruthy()
  })
})
