import { beforeEach, describe, expect, it } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import { CloudDataSource } from '../../../src/main/database/cloud/CloudDataSource'
import { CloudConfigRepository } from '../../../src/main/database/cloud/CloudConfigRepository'

function setup(): { ds: CloudDataSource; mock: MockAdapter } {
  const ds = new CloudDataSource({ baseUrl: 'https://api.example.com' })
  ds.setTokenStore({ getAccessToken: () => 'tok' })
  const mock = new MockAdapter(ds['client'])
  return { ds, mock }
}

// CloudAuthRepository 及其 AUTH-03/04/08 用例已随 R8-2 删除：
// 云端 HTTP 登录面（login-password/sms/wechat/refresh）在生产链路零调用
// （桌面端登录凭据始终校验本地 users 表，Web 身份经 OAuth2 关联）。

describe('CloudConfigRepository', () => {
  let ds: CloudDataSource
  let mock: MockAdapter
  let repo: CloudConfigRepository

  beforeEach(() => {
    ;({ ds, mock } = setup())
    repo = new CloudConfigRepository(ds)
  })

  it('get 返回配置值', async () => {
    mock.onGet('/api/config/k1').reply(200, { code: 0, data: 'v1' })
    expect(await repo.get('k1')).toBe('v1')
  })

  it('set 调 PUT 接口', async () => {
    mock.onPut('/api/config/k1').reply(200, { code: 0, data: null })
    await expect(repo.set('k1', 'v1')).resolves.toBeUndefined()
  })
})
