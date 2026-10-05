import type { IpcResult } from '../../shared/contracts'

/**
 * IPC 结果包裹的唯一实现（历史：15 个 handler 文件各自复制 ok/fail）。
 * 成功载荷形状与失败 {success:false,error} 约定保持不变，渲染层零改动。
 */
export function ok<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

export function fail<T = never>(error: string): IpcResult<T> {
  return { success: false, error }
}

/** 异常 → 可读 message（避免 undefined/空串破坏渲染层的错误提示） */
export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message || '操作失败'
}
