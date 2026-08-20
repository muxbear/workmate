import { beforeEach, describe, expect, it } from 'vitest'
import { LocalDataSource } from '../../../src/main/database/local/LocalDataSource'
import { LocalAuthRepository } from '../../../src/main/database/local/LocalAuthRepository'
import { AuthService, type AuthServiceDeps } from '../../../src/main/services/AuthService'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'
import type { OAuth2Token } from '../../../src/main/oauth2/types'

const JWT_SECRET = 'test-secret-0123456789abcdef'

function makeToken(webUserId = 'web-1'): OAuth2Token {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3600_000,
    scope: 'skill:read user:read',
    webUser: { id: webUserId, nickname: 'Tester', avatar: '' }
  }
}

async function setup(): Promise<{
  service: AuthService
  repo: LocalAuthRepository
}> {
  const ds = new LocalDataSource(':memory:')
  const repo = new LocalAuthRepository(ds)
  const deps: AuthServiceDeps = {
    repository: repo,
    localAuthRepository: repo,
    jwtSecret: JWT_SECRET,
    secureStorage: new InMemorySecureStorage()
  }
  return { service: new AuthService(deps), repo }
}

describe('AuthService.loginByOAuth2（方案 7.3 四分支）', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  it('无绑定 + 无当前登录：新建 web-only 用户并登录', async () => {
    const token = makeToken('web-new')
    const result = await ctx.service.loginByOAuth2(token.webUser, token, null, false)
    expect(result.status).toBe('logged-in')
    const user = await ctx.repo.findByAccount(`web_web-new`)
    expect(user?.webAccountId).toBe('web-new')
    expect(user?.isWebOnly).toBe(true)
    expect(await ctx.repo.getOAuth2Session(user!.id)).toMatchObject({
      webAccountId: 'web-new',
      scope: 'skill:read user:read'
    })
  })

  it('已绑定 + 当前用户相同：直接登录', async () => {
    const token = makeToken('web-1')
    await ctx.service.loginByOAuth2(token.webUser, token, null, false)
    const bound = await ctx.repo.findByWebAccountId('web-1')
    const result = await ctx.service.loginByOAuth2(
      token.webUser,
      token,
      bound!.id,
      false
    )
    expect(result.status).toBe('logged-in')
    expect(result.user?.id).toBe(bound!.id)
  })

  it('无绑定 + 当前用户已绑定其他 Web 账号：需确认换绑，确认后换绑', async () => {
    // 先让本地用户 A 绑定 web-x
    const first = makeToken('web-x')
    await ctx.service.loginByOAuth2(first.webUser, first, null, false)
    const userA = (await ctx.repo.findByWebAccountId('web-x'))!

    // 当前登录 A，新授权 web-y（未绑定）
    const second = makeToken('web-y')
    const pending = await ctx.service.loginByOAuth2(
      second.webUser,
      second,
      userA.id,
      false
    )
    expect(pending.status).toBe('needs-confirmation')
    expect(pending.action).toBe('rebind')
    // 未确认：绑定不变
    expect((await ctx.repo.findById(userA.id))?.webAccountId).toBe('web-x')

    const confirmed = await ctx.service.loginByOAuth2(
      second.webUser,
      second,
      userA.id,
      true
    )
    expect(confirmed.status).toBe('logged-in')
    expect((await ctx.repo.findById(userA.id))?.webAccountId).toBe('web-y')
    expect(await ctx.repo.findByWebAccountId('web-x')).toBeNull()
  })

  it('无绑定 + 当前用户未绑定：需确认新建并切换登录', async () => {
    const current = await ctx.repo.createUser({ username: 'local-user' })
    const token = makeToken('web-z')
    const pending = await ctx.service.loginByOAuth2(
      token.webUser,
      token,
      current.id,
      false
    )
    expect(pending.status).toBe('needs-confirmation')
    expect(pending.action).toBe('switch-identity')

    const confirmed = await ctx.service.loginByOAuth2(
      token.webUser,
      token,
      current.id,
      true
    )
    expect(confirmed.status).toBe('logged-in')
    expect(confirmed.user?.username).toBe('web_web-z')
    // 原本地用户绑定不受影响
    expect((await ctx.repo.findById(current.id))?.webAccountId).toBeUndefined()
  })

  it('Web 账号已绑定其他本地用户 + 当前不同：确认后切换登录到绑定用户', async () => {
    const token = makeToken('web-1')
    await ctx.service.loginByOAuth2(token.webUser, token, null, false)
    const bound = (await ctx.repo.findByWebAccountId('web-1'))!
    const other = await ctx.repo.createUser({ username: 'other-user' })

    const pending = await ctx.service.loginByOAuth2(
      token.webUser,
      token,
      other.id,
      false
    )
    expect(pending.status).toBe('needs-confirmation')
    expect(pending.action).toBe('switch-identity')

    const confirmed = await ctx.service.loginByOAuth2(
      token.webUser,
      token,
      other.id,
      true
    )
    expect(confirmed.status).toBe('logged-in')
    expect(confirmed.user?.id).toBe(bound.id)
  })
})
