import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 响应拦截器的错误提示层（迭代 6 T6.6）。
 *
 * `tests/services/request.test.ts` 此前只覆盖 SSE 解析——拦截器、`ApiError`、
 * token 刷新、错误文案**零覆盖**，而本批次改的正是这些。
 *
 * 要盯住的核心是**文案必须是后端想说的那句话**：HTTP 状态错误的 `Error.message` 是
 * axios 造的 `"Request failed with status code 413"`，真正的中文说明在
 * `response.data.detail` 上。不读它，用户看到的只是一串状态码——此前
 * `readApiError` 的注释里写着这个坑，现在它和拦截器共用同一份实现。
 */

const errorSpy = vi.fn()

vi.mock('element-plus', () => ({
  ElMessage: { error: (...args: unknown[]) => errorSpy(...args) },
  // request.ts 只用到 ElMessage；别的导出给个占位免得其它导入炸掉
  ElNotification: { error: vi.fn() },
}))

// 401 分支会动态导入 auth store；这里给一个可切换成败的桩
let refreshFails = true
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    refreshAccessToken: async () => {
      if (refreshFails) throw new Error('refresh boom')
    },
  }),
}))

const { default: instance, extractErrorMessage } = await import('@/services/request')

/** 造一个"真实 adapter 会抛出来的" AxiosError 形状。 */
function httpError(status: number, body: unknown, config?: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    config,
    response: { status, statusText: '', headers: {}, config, data: body },
  })
}

/** 让下一次请求按给定方式失败。 */
function failWith(error: unknown) {
  return (config: unknown) => Promise.reject(httpError(
    (error as { response?: { status?: number } })?.response?.status ?? 500,
    (error as { response?: { data?: unknown } })?.response?.data,
    config,
  ))
}

beforeEach(() => {
  errorSpy.mockReset()
  sessionStorage.clear()
})

describe('extractErrorMessage', () => {
  it('优先取后端的 detail（那才是给人看的话）', () => {
    expect(extractErrorMessage(httpError(413, { detail: '文件超过 100MB 上限' })))
      .toBe('文件超过 100MB 上限')
  })

  it('没有 detail 时用 body 里的 message', () => {
    expect(extractErrorMessage(httpError(400, { message: '参数不合法' }))).toBe('参数不合法')
  })

  it('校验错误的 detail 是数组时取第一条的 msg', () => {
    // FastAPI 的 422 是 [{loc, msg, type}, ...]——不处理就退回状态码文案
    expect(extractErrorMessage(httpError(422, {
      detail: [{ msg: '字段必填', loc: ['body', 'name'] }],
    }))).toBe('字段必填')
  })

  it('超时与网络错误给中文说法，而不是英文原文', () => {
    expect(extractErrorMessage({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }))
      .toBe('请求超时，请稍后重试')
    expect(extractErrorMessage({ code: 'ERR_NETWORK', message: 'Network Error' }))
      .toBe('网络异常，请检查网络后重试')
  })

  it('认不出时兜底，不把 undefined 抛到界面上', () => {
    expect(extractErrorMessage(null)).toBe('操作失败')
    expect(extractErrorMessage({})).toBe('操作失败')
  })
})

describe('拦截器 · 全局提示开关', () => {
  it('默认不弹（与既有行为一致，避免全站 90 处双重报错）', async () => {
    await expect(
      instance.get('/x', { adapter: failWith(httpError(500, { detail: '炸了' })) }),
    ).rejects.toBeTruthy()

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('标了 notify 才弹，且弹的是后端的 detail', async () => {
    await expect(
      instance.get('/x', {
        notify: true,
        adapter: failWith(httpError(500, { detail: '向量库连不上' })),
      }),
    ).rejects.toBeTruthy()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith('向量库连不上')
  })

  it('响应体里的 code!=0 同样按 notify 决定', async () => {
    // config 必须透传：拦截器是从 response.config 上读 notify 的，
    // 桩里写死 `config: {}` 会让开关永远读不到——第一版就是这样空转的
    const adapter = (config: unknown) => Promise.resolve({
      status: 200, statusText: 'OK', headers: {}, config,
      data: { code: 40001, message: '知识库不存在' },
    })

    await expect(
      instance.get('/x', { notify: true, adapter }),
    ).rejects.toBeTruthy()
    expect(errorSpy).toHaveBeenCalledWith('知识库不存在')

    errorSpy.mockReset()
    await expect(instance.get('/x', { adapter })).rejects.toBeTruthy()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('拦截器 · 401 路径', () => {
  it('刷新失败时 reject（不是 resolve 出 undefined）', async () => {
    // 这条曾被误读成"拦截器会 resolve undefined"：catch 块里不 return 的话，
    // 控制流会落到末尾的 reject——实测确认是 reject。用例把它钉住。
    sessionStorage.setItem('auth_tokens', JSON.stringify({
      accessToken: 'a', refreshToken: 'r',
    }))
    refreshFails = true

    const outcome = await instance
      .get('/x', { notify: true, adapter: failWith(httpError(401, { detail: '未授权' })) })
      .then(() => 'resolved')
      .catch(() => 'rejected')

    expect(outcome).toBe('rejected')
  })

  it('刷新失败时不弹提示（正在跳登录页，弹了也看不到）', async () => {
    sessionStorage.setItem('auth_tokens', JSON.stringify({
      accessToken: 'a', refreshToken: 'r',
    }))
    refreshFails = true

    await expect(
      instance.get('/x', { notify: true, adapter: failWith(httpError(401, { detail: '未授权' })) }),
    ).rejects.toBeTruthy()

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('无刷新令牌时清掉 token 并 reject', async () => {
    sessionStorage.setItem('auth_tokens', JSON.stringify({ accessToken: 'a' }))
    refreshFails = true

    await expect(
      instance.get('/x', { adapter: failWith(httpError(401, {})) }),
    ).rejects.toBeTruthy()

    expect(sessionStorage.getItem('auth_tokens')).toBeNull()
  })
})
