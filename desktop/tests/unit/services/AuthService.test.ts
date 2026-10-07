import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../../../src/main/security/crypto'
import { LocalDataSource } from '../../../src/main/database/local/LocalDataSource'
import { LocalAuthRepository } from '../../../src/main/database/local/LocalAuthRepository'
import { AuthService, type AuthServiceDeps } from '../../../src/main/services/AuthService'
import { InMemorySecureStorage } from '../../../src/main/security/secure-storage'

const JWT_SECRET = 'test-secret-0123456789abcdef'

async function setup(now: number): Promise<{
  service: AuthService
  repo: LocalAuthRepository
  advance: (ms: number) => void
}> {
  const ds = new LocalDataSource(':memory:')
  const repo = new LocalAuthRepository(ds)
  let current = now
  const deps: AuthServiceDeps = {
    repository: repo,
    jwtSecret: JWT_SECRET,
    secureStorage: new InMemorySecureStorage(),
    now: () => current,
    smsSender: { send: async () => {} },
    wechatClient: { exchangeCode: async () => 'openid-test' }
  }
  const service = new AuthService(deps)
  return { service, repo, advance: (ms) => (current += ms) }
}

describe('AuthService 密码登录', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup(1_000_000)
    const hash = await hashPassword('Secret123!')
    await ctx.repo.createUser({ username: 'wangke', passwordHash: hash, mobile: '13800138000' })
  })

  it('AUTH-01: 正确账号密码登录成功，返回 token+user 并写审计', async () => {
    const result = await ctx.service.loginByPassword('wangke', 'Secret123!')
    expect(result.token).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(result.user.username).toBe('wangke')
    const log = ctx.repo['ds']
      .getDb()
      .prepare('SELECT * FROM audit_logs WHERE action = ?')
      .all('login')
    expect(log.length).toBeGreaterThan(0)
  })

  it('AUTH-02: 错误密码抛统一错误且失败计数+1', async () => {
    await expect(ctx.service.loginByPassword('wangke', 'WrongPass!')).rejects.toThrow(
      '账号或密码错误'
    )
    const user = await ctx.repo.findByAccount('wangke')
    expect(user!.failedLoginAttempts).toBe(1)
  })

  it('SEC-12: 连续 5 次失败锁定 15 分钟', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.loginByPassword('wangke', 'WrongPass!')).rejects.toThrow()
    }
    await expect(ctx.service.loginByPassword('wangke', 'Secret123!')).rejects.toThrow(/锁定/)
  })

  it('SEC-13: 锁定期间正确密码也拒绝', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.loginByPassword('wangke', 'WrongPass!')).rejects.toThrow()
    }
    await expect(ctx.service.loginByPassword('wangke', 'Secret123!')).rejects.toThrow(/锁定/)
  })

  it('SEC-14: 锁定 15 分钟后解锁，登录成功且计数清零', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(ctx.service.loginByPassword('wangke', 'WrongPass!')).rejects.toThrow()
    }
    ctx.advance(15 * 60 * 1000 + 1)
    const result = await ctx.service.loginByPassword('wangke', 'Secret123!')
    expect(result.token).toBeTruthy()
    const user = await ctx.repo.findByAccount('wangke')
    expect(user!.failedLoginAttempts).toBe(0)
    expect(user!.lockedUntil).toBeNull()
  })

  it('不存在的账号返回统一错误（防用户枚举）', async () => {
    await expect(ctx.service.loginByPassword('ghost', 'whatever1')).rejects.toThrow(
      '账号或密码错误'
    )
  })
})

describe('AuthService 短信登录', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  const sentCodes: string[] = []

  beforeEach(async () => {
    sentCodes.length = 0
    ctx = await setup(1_000_000)
    // 覆盖 smsSender 记录验证码
    ;(
      ctx.service as unknown as {
        smsSender: { send: (m: string, c: string) => Promise<void> }
      }
    ).smsSender = {
      send: async (_m: string, code: string) => {
        sentCodes.push(code)
      }
    }
  })

  it('发送验证码：生成 6 位数字码并调用发送器', async () => {
    await ctx.service.sendSmsCode('13800138000')
    expect(sentCodes.length).toBe(1)
    expect(sentCodes[0]).toMatch(/^\d{6}$/)
  })

  it('AUTH-06: 正确验证码登录成功；未注册手机号自动注册', async () => {
    await ctx.service.sendSmsCode('13900139000')
    const code = sentCodes[sentCodes.length - 1]
    const result = await ctx.service.loginBySms('13900139000', code)
    expect(result.user.mobile).toBe('13900139000')
  })

  it('SEC-15: 过期验证码拒绝', async () => {
    await ctx.service.sendSmsCode('13800138000')
    const code = sentCodes[sentCodes.length - 1]
    ctx.advance(5 * 60 * 1000 + 1)
    await expect(ctx.service.loginBySms('13800138000', code)).rejects.toThrow(/验证码/)
  })

  it('SEC-16: 验证码一次性，复用拒绝', async () => {
    await ctx.service.sendSmsCode('13800138000')
    const code = sentCodes[sentCodes.length - 1]
    await ctx.service.loginBySms('13800138000', code)
    await expect(ctx.service.loginBySms('13800138000', code)).rejects.toThrow(/验证码/)
  })

  it('错误验证码拒绝', async () => {
    await ctx.service.sendSmsCode('13800138000')
    await expect(ctx.service.loginBySms('13800138000', '000000')).rejects.toThrow(/验证码/)
  })

  it('非法手机号拒绝发送', async () => {
    await expect(ctx.service.sendSmsCode('123')).rejects.toThrow(/手机号/)
  })
})

describe('AuthService 微信登录', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup(1_000_000)
  })

  it('AUTH-07: 合法 code 登录成功；未注册 openid 自动注册', async () => {
    const result = await ctx.service.loginByWechat('code-1')
    expect(result.user.username).toBeTruthy()
    // 再次登录同一 code 对应的 openid，返回同一用户
    const result2 = await ctx.service.loginByWechat('code-1')
    expect(result2.user.id).toBe(result.user.id)
  })
})

describe('AuthService token 与登出', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup(1_000_000)
    const hash = await hashPassword('Secret123!')
    await ctx.repo.createUser({ username: 'wangke', passwordHash: hash })
  })

  it('SEC-09: 登录后数据库仅存 token 的 SHA-256 哈希', async () => {
    const result = await ctx.service.loginByPassword('wangke', 'Secret123!')
    const user = await ctx.repo.findByAccount('wangke')
    expect(user!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(user!.tokenHash).not.toContain(result.token)
  })

  it('AUTH-10: 登出后 token 失效并写审计', async () => {
    await ctx.service.loginByPassword('wangke', 'Secret123!')
    await ctx.service.logout('wangke')
    const user = await ctx.repo.findByAccount('wangke')
    expect(user!.tokenHash).toBeNull()
    const log = ctx.repo['ds']
      .getDb()
      .prepare('SELECT * FROM audit_logs WHERE action = ?')
      .all('logout')
    expect(log.length).toBe(1)
  })
})

describe('AuthService 展示资料（session:check 权威来源）', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup(1_000_000)
    const hash = await hashPassword('Secret123!')
    await ctx.repo.createUser({ username: 'wangke', passwordHash: hash, mobile: '13800138000' })
  })

  it('AUTH-11: getProfileById 返回 id/username/mobile（不含口令哈希等敏感字段）', async () => {
    const user = await ctx.repo.findByAccount('wangke')
    const profile = await ctx.service.getProfileById(user!.id)
    expect(profile).toEqual({ id: user!.id, username: 'wangke', mobile: '13800138000' })
    expect(Object.keys(profile!)).not.toContain('passwordHash')
  })

  it('AUTH-12: getProfileById 对不存在的用户返回 null（不抛错）', async () => {
    await expect(ctx.service.getProfileById('no-such-id')).resolves.toBeNull()
  })

  it('AUTH-13: updateNickname trim 后落库，返回最新资料并写审计', async () => {
    const user = await ctx.repo.findByAccount('wangke')
    const profile = await ctx.service.updateNickname(user!.id, '  老王  ')
    expect(profile).toEqual({
      id: user!.id,
      username: 'wangke',
      mobile: '13800138000',
      nickname: '老王'
    })
    expect((await ctx.repo.findById(user!.id))!.nickname).toBe('老王')
    const log = ctx.repo['ds']
      .getDb()
      .prepare('SELECT * FROM audit_logs WHERE action = ?')
      .all('update_nickname')
    expect(log.length).toBeGreaterThan(0)
  })

  it('AUTH-14: 空串/纯空白 = 清除昵称（显示名回退登录账号）', async () => {
    const user = await ctx.repo.findByAccount('wangke')
    await ctx.service.updateNickname(user!.id, '老王')
    const cleared = await ctx.service.updateNickname(user!.id, '   ')
    expect(cleared.nickname).toBeUndefined()
    expect((await ctx.repo.findById(user!.id))!.nickname).toBeUndefined()
  })

  it('AUTH-15: 超长与控制字符被拒且不落库', async () => {
    const user = await ctx.repo.findByAccount('wangke')
    await expect(ctx.service.updateNickname(user!.id, 'a'.repeat(21))).rejects.toThrow(
      '昵称不能超过 20 个字符'
    )
    const withNewline = `老${String.fromCharCode(10)}王`
    await expect(ctx.service.updateNickname(user!.id, withNewline)).rejects.toThrow(
      '昵称不能包含非法字符'
    )
    expect((await ctx.repo.findById(user!.id))!.nickname).toBeUndefined()
  })

  it('AUTH-16: 不存在的账号抛「账号不存在」且不写审计', async () => {
    await expect(ctx.service.updateNickname('no-such-id', '老王')).rejects.toThrow('账号不存在')
    const log = ctx.repo['ds']
      .getDb()
      .prepare('SELECT * FROM audit_logs WHERE action = ?')
      .all('update_nickname')
    expect(log.length).toBe(0)
  })
})
