import { describe, expect, it } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import { WebApiClient } from '../../../src/main/network/web-api-client'

/**
 * 同步家族共享 HTTP 客户端：envelope 解包 / 错误归一（含 arraybuffer 错误体）/ 二进制下载。
 * 历史实现四个同步源各有一份 request 样板且错误解析互有差异，收敛后行为以本测试为准。
 */
describe('WebApiClient', () => {
  it('envelope.code===0 解包 data；尾斜杠会被归一化', async () => {
    const client = new WebApiClient('http://api.example.com/')
    const mock = new MockAdapter(client.axiosInstance)
    mock.onGet('/api/x').reply((config) => {
      expect(config.baseURL).toBe('http://api.example.com')
      return [200, { code: 0, data: { ok: 1 }, message: '' }]
    })
    await expect(client.request('get', '/api/x')).resolves.toEqual({ ok: 1 })
  })

  it('envelope.code!==0 → 抛 message', async () => {
    const client = new WebApiClient('http://api.example.com')
    const mock = new MockAdapter(client.axiosInstance)
    mock.onGet('/api/x').reply(200, { code: 4001, data: null, message: '没有权限' })
    await expect(client.request('get', '/api/x')).rejects.toThrow('没有权限')
  })

  it('HTTP 错误（message/detail 字段）→ 可读 message', async () => {
    const client = new WebApiClient('http://api.example.com')
    const mock = new MockAdapter(client.axiosInstance)
    mock.onGet('/api/x').reply(500, { detail: '服务端炸了' })
    await expect(client.request('get', '/api/x')).rejects.toThrow('服务端炸了')
  })

  it('arraybuffer 错误体（下载接口）→ 解析 message 字段', async () => {
    const client = new WebApiClient('http://api.example.com')
    const mock = new MockAdapter(client.axiosInstance)
    const body = new TextEncoder().encode('{"message":"技能包已下架"}')
    mock.onGet('/api/download').reply(404, body.buffer, { 'Content-Type': 'application/json' })
    await expect(client.download('/api/download')).rejects.toThrow('技能包已下架')
  })

  it('download 成功 → Uint8Array（arraybuffer 兼容）', async () => {
    const client = new WebApiClient('http://api.example.com')
    const mock = new MockAdapter(client.axiosInstance)
    const bytes = new Uint8Array([1, 2, 3])
    mock.onGet('/api/download').reply(200, bytes.buffer)
    const result = await client.download('/api/download')
    expect(Array.from(result)).toEqual([1, 2, 3])
  })
})
