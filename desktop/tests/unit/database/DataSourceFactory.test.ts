import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataSourceFactory } from '../../../src/main/database/DataSourceFactory'

describe('DataSourceFactory', () => {
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

  it('DSF-02: local 模式创建 Local 实现', () => {
    factory.setMode('local')
    expect(factory.createConfigRepository().constructor.name).toBe('LocalConfigRepository')
  })

  it('DSF-04: 认证存储始终为本地实现（local 模式）', () => {
    factory.setMode('local')
    expect(factory.createLocalAuthRepository().constructor.name).toBe('LocalAuthRepository')
  })

  it('DSF-03: cloud 模式创建 Cloud 实现', () => {
    factory.configure({ cloudBaseUrl: 'https://api.example.com' })
    factory.setMode('cloud')
    expect(factory.createConfigRepository().constructor.name).toBe('CloudConfigRepository')
  })

  it('cloud 模式下认证存储仍为本地实现（登录凭据不随工作模式走云端）', () => {
    factory.setMode('cloud')
    expect(factory.createLocalAuthRepository().constructor.name).toBe('LocalAuthRepository')
  })

  it('WM-04: setMode 通知订阅者且能获取对应实现', () => {
    const listener = vi.fn()
    factory.onModeChanged(listener)
    factory.setMode('cloud')
    expect(listener).toHaveBeenCalledWith('cloud')
    factory.setMode('local')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('create 方法按当前模式返回实现', () => {
    factory.setMode('local')
    const local = factory.createConfigRepository()
    expect(local.constructor.name).toBe('LocalConfigRepository')
  })
})
