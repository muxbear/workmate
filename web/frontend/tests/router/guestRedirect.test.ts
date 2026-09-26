import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import appRouter from '@/router'
import { useAuthStore } from '@/stores/auth'

// 回归测试：已登录用户访问游客页（/login、/register 等）时，
// 必须重定向到应用内真实存在的路由，否则会落到无匹配记录的路由导致整页空白。
describe('真实路由：已登录用户访问游客页', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  it('已登录用户访问 /login 时跳到主页面而不是空白页', async () => {
    const authStore = useAuthStore()
    authStore.setTokens({ accessToken: 'test-at', refreshToken: 'test-rt', expiresIn: 7200 })

    await appRouter.push('/login')
    await appRouter.isReady()

    const route = appRouter.currentRoute.value
    expect(route.path).not.toBe('/login')
    expect(route.matched.length).toBeGreaterThan(0)
    expect(['/', '/overview']).toContain(route.path)
  }, 30000)

  it('未登录用户仍可正常打开登录页', async () => {
    await appRouter.push('/login')
    await appRouter.isReady()

    expect(appRouter.currentRoute.value.name).toBe('login')
    expect(appRouter.currentRoute.value.matched.length).toBeGreaterThan(0)
  }, 30000)
})

// 链接分享落地页（迭代 6 T6.3）：**登录与未登录都必须能停留**。
// 两个容易踩的坑：加 `meta.guest` 会把已登录用户弹回首页（而"已登录的人点链接"
// 恰恰最常见）；漏注册则会被兜底 catch-all 静默重定向到 `/`，表现为"链接打不开"。
describe('真实路由：分享落地页两种登录态都可达', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  it('未登录用户可打开 /share/kb/:token', async () => {
    await appRouter.push('/share/kb/tok-abc')
    await appRouter.isReady()

    const route = appRouter.currentRoute.value
    expect(route.name).toBe('kb-share-preview')
    expect(route.path).toBe('/share/kb/tok-abc')
    expect(route.params.token).toBe('tok-abc')
  }, 30000)

  it('已登录用户也能打开（不被 guest 守卫弹走）', async () => {
    const authStore = useAuthStore()
    authStore.setTokens({ accessToken: 'test-at', refreshToken: 'test-rt', expiresIn: 7200 })

    await appRouter.push('/share/kb/tok-abc')
    await appRouter.isReady()

    expect(appRouter.currentRoute.value.name).toBe('kb-share-preview')
  }, 30000)
})
