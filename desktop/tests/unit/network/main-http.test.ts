import { afterEach, describe, expect, it, vi } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import {
  configureMainHttpProxyResolver,
  createMainHttpClient,
  toHttpErrorMessage
} from '../../../src/main/network/main-http'

const PROXY = { host: '127.0.0.1', port: 7890, protocol: 'http' as const }

afterEach(() => {
  // 全局解析器按用例配置，测试间必须复位
  configureMainHttpProxyResolver(undefined)
})

describe('createMainHttpClient（R8-5 统一客户端）', () => {
  it('相对路径请求：按 baseURL 拼出的目标 URL 解析代理并注入', async () => {
    const seenTargets: string[] = []
    const client = createMainHttpClient({
      purpose: 'test',
      baseURL: 'https://api.example.com',
      resolveProxy: async (target) => {
        seenTargets.push(target)
        return PROXY
      }
    })
    let seenProxy: unknown
    const mock = new MockAdapter(client)
    mock.onGet('/api/x').reply((config) => {
      seenProxy = config.proxy
      return [200, { ok: 1 }]
    })

    await client.get('/api/x')

    expect(seenTargets).toEqual(['https://api.example.com/api/x'])
    expect(seenProxy).toEqual(PROXY)
  })

  it('绝对 URL 请求：直接以该 URL 解析（不拼 baseURL）', async () => {
    const seenTargets: string[] = []
    const client = createMainHttpClient({
      purpose: 'test',
      baseURL: 'https://api.example.com',
      resolveProxy: async (target) => {
        seenTargets.push(target)
        return undefined
      }
    })
    const mock = new MockAdapter(client)
    mock.onPost('http://gw.internal/v1/embeddings').reply(200, {})

    await client.post('http://gw.internal/v1/embeddings', {})

    expect(seenTargets).toEqual(['http://gw.internal/v1/embeddings'])
  })

  it('解析为直连时显式 proxy:false（切断 axios 环境变量代理回退）', async () => {
    const client = createMainHttpClient({
      purpose: 'test',
      resolveProxy: async () => undefined
    })
    let seenProxy: unknown = 'unset'
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenProxy = config.proxy
      return [200, {}]
    })

    await client.get('/x')

    expect(seenProxy).toBe(false)
  })

  it('调用方显式指定 proxy 时优先，不触发解析', async () => {
    const resolveProxy = vi.fn(async () => PROXY)
    const client = createMainHttpClient({ purpose: 'test', resolveProxy })
    let seenProxy: unknown
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenProxy = config.proxy
      return [200, {}]
    })

    const explicit = { host: '10.0.0.9', port: 3128, protocol: 'http' as const }
    await client.get('/x', { proxy: explicit })

    expect(seenProxy).toEqual(explicit)
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  it('未配置解析器时不设置 proxy（保持 axios 缺省行为）', async () => {
    const client = createMainHttpClient({ purpose: 'test' })
    let seenProxy: unknown = 'unset'
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenProxy = config.proxy
      return [200, {}]
    })

    await client.get('/x')

    expect(seenProxy).toBeUndefined()
  })

  it('解析器抛错：请求照常发出（降级直连）并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = createMainHttpClient({
      purpose: 'test',
      resolveProxy: async () => {
        throw new Error('resolveProxy 挂了')
      }
    })
    let seenProxy: unknown = 'unset'
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenProxy = config.proxy
      return [200, {}]
    })

    await client.get('/x')

    expect(seenProxy).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('组合根配置的全局解析器生效（客户端可先于配置构造）', async () => {
    const client = createMainHttpClient({ purpose: 'test' })
    configureMainHttpProxyResolver(async () => PROXY)
    let seenProxy: unknown
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenProxy = config.proxy
      return [200, {}]
    })

    await client.get('/x')

    expect(seenProxy).toEqual(PROXY)
  })

  it('统一 User-Agent 与超时缺省（可覆盖）', async () => {
    const client = createMainHttpClient({ purpose: 'test', timeoutMs: 3000 })
    let seenUa: unknown
    let seenTimeout: unknown
    const mock = new MockAdapter(client)
    mock.onGet('/x').reply((config) => {
      seenUa = config.headers?.['User-Agent']
      seenTimeout = config.timeout
      return [200, {}]
    })

    await client.get('/x')

    expect(seenUa).toBe('KeWork-Desktop')
    expect(seenTimeout).toBe(3000)
  })
})

describe('toHttpErrorMessage', () => {
  it('axios 错误：取 message / detail 字段', async () => {
    const client = createMainHttpClient({ purpose: 'test' })
    const mock = new MockAdapter(client)
    mock.onGet('/a').reply(500, { detail: '服务端炸了' })
    mock.onGet('/b').reply(500, { message: '没有权限' })
    const errA = await client.get('/a').catch((err: unknown) => err)
    const errB = await client.get('/b').catch((err: unknown) => err)
    expect(toHttpErrorMessage(errA)).toBe('服务端炸了')
    expect(toHttpErrorMessage(errB)).toBe('没有权限')
  })

  it('非 axios 错误回退 Error.message；无 message 用缺省文案', () => {
    expect(toHttpErrorMessage(new Error('boom'))).toBe('boom')
    expect(toHttpErrorMessage('oops', '兜底')).toBe('兜底')
    expect(toHttpErrorMessage(undefined)).toBe('网络请求失败')
  })
})
