import { describe, expect, it, vi } from 'vitest'
import { registerRemoteImageHandlers } from '../../../src/main/ipc/image-handlers'

function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    handlers,
    async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
      return handlers.get(channel)!({} as never, ...args) as T
    }
  }
}

describe('远程图片 IPC handlers（images:resolve）', () => {
  it('注册 images:resolve 通道', () => {
    const ipc = createFakeIpcMain()
    registerRemoteImageHandlers(ipc as never, {
      remoteImageService: { resolveRemoteImage: vi.fn() } as never,
      requireUserId: () => 'u1'
    })
    expect(ipc.handle).toHaveBeenCalledWith('images:resolve', expect.any(Function))
  })

  it('未登录拒绝（requireUserId 抛错返回 success:false）', async () => {
    const ipc = createFakeIpcMain()
    registerRemoteImageHandlers(ipc as never, {
      remoteImageService: { resolveRemoteImage: vi.fn() } as never,
      requireUserId: () => {
        throw new Error('未登录')
      }
    })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'images:resolve', 'https://a.com/1.png'
    )
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('参数错误：url 非字符串', async () => {
    const ipc = createFakeIpcMain()
    registerRemoteImageHandlers(ipc as never, {
      remoteImageService: { resolveRemoteImage: vi.fn() } as never,
      requireUserId: () => 'u1'
    })
    const result = await ipc.invoke<{ success: boolean; error?: string }>('images:resolve', 42)
    expect(result.success).toBe(false)
    expect(result.error).toBe('参数错误')
  })

  it('成功返回本地 ke-img:// 地址', async () => {
    const ipc = createFakeIpcMain()
    const resolve = vi.fn(async (_url: string) => 'ke-img://img/abc')
    registerRemoteImageHandlers(ipc as never, {
      remoteImageService: { resolveRemoteImage: resolve } as never,
      requireUserId: () => 'u1'
    })
    const result = await ipc.invoke<{ success: boolean; data?: { url: string } }>(
      'images:resolve', 'https://a.com/1.png'
    )
    expect(result).toEqual({ success: true, data: { url: 'ke-img://img/abc' } })
  })

  it('解析失败返回 error', async () => {
    const ipc = createFakeIpcMain()
    const resolve = vi.fn(async () => {
      throw new Error('下载失败')
    })
    registerRemoteImageHandlers(ipc as never, {
      remoteImageService: { resolveRemoteImage: resolve } as never,
      requireUserId: () => 'u1'
    })
    const result = await ipc.invoke<{ success: boolean; error?: string }>(
      'images:resolve', 'https://a.com/2.png'
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('下载失败')
  })
})
