import { vi } from 'vitest'

type MockFn = ReturnType<typeof vi.fn>

export interface SyncMockProgress {
  phase: string
  percent: number
  message?: string
}

export interface SyncMockApi {
  getStatus: MockFn
  authorize: MockFn
  sync: MockFn
  loadLocal: MockFn
  disconnect: MockFn
  onSyncProgress: MockFn
  /** 手动推送一条进度事件给当前订阅者（模拟主进程进度） */
  pushProgress(progress: SyncMockProgress): void
}

/**
 * 同步域 api 假实现（三域同构：expert / automationTemplateSync / skillSync 的公共六通道）。
 *
 * 用法：`const api = createSyncMockApi()` → 按需 `api.sync.mockImplementation(...)` 定制，
 * 再 `vi.stubGlobal('window', { api: { <namespace>: { ...api, <域特有方法> } } })`。
 * 缺省状态：已授权；sync/loadLocal 需自行 mockImplementation（断言数据由测试提供）。
 */
export function createSyncMockApi(): SyncMockApi {
  let progressCb: ((p: SyncMockProgress) => void) | null = null
  const getStatus = vi.fn()
  getStatus.mockResolvedValue({
    success: true,
    data: { status: 'authorized', webUser: { id: 'u1', nickname: 'demo', avatar: null } }
  })
  const authorize = vi.fn()
  authorize.mockResolvedValue({
    success: true,
    data: { webUser: { id: 'u1', nickname: 'demo', avatar: null } }
  })
  const loadLocal = vi.fn()
  loadLocal.mockResolvedValue({ success: true, data: null })
  const disconnect = vi.fn()
  disconnect.mockResolvedValue({ success: true, data: null })
  const onSyncProgress = vi.fn((cb: (p: SyncMockProgress) => void) => {
    progressCb = cb
    return () => {
      progressCb = null
    }
  })
  return {
    getStatus,
    authorize,
    sync: vi.fn(),
    loadLocal,
    disconnect,
    onSyncProgress,
    pushProgress: (progress: SyncMockProgress) => progressCb?.(progress)
  }
}
