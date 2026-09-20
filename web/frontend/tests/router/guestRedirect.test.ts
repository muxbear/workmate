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
