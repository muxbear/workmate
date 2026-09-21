import { artifactDownloadUrl, getAccessToken } from '@/services/request'

/** 产物取回结果：区分成功、已过期与普通失败，便于预览面板给出对应提示 */
export interface ArtifactFetchResult {
  ok: boolean
  /** HTTP 状态码；网络异常时为 0 */
  status: number
  /** 产物已过期或不可恢复（服务端返回 410） */
  expired: boolean
  blob: Blob | null
}

/** 带鉴权拉取会话产物内容；失败返回带状态的结果，由调用方降级展示 */
export async function fetchArtifactBlob(
  threadId: string,
  path: string,
  disposition: 'inline' | 'attachment' = 'inline',
): Promise<ArtifactFetchResult> {
  if (!threadId || !path) {
    return { ok: false, status: 0, expired: false, blob: null }
  }
  try {
    const response = await fetch(artifactDownloadUrl(threadId, path, disposition), {
      headers: { Authorization: 'Bearer ' + (getAccessToken() ?? '') },
    })
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        expired: response.status === 410,
        blob: null,
      }
    }
    return { ok: true, status: response.status, expired: false, blob: await response.blob() }
  } catch {
    return { ok: false, status: 0, expired: false, blob: null }
  }
}

/** 下载产物到本地（浏览器触发另存为） */
export async function downloadArtifact(
  threadId: string,
  path: string,
  name: string,
): Promise<void> {
  const result = await fetchArtifactBlob(threadId, path, 'attachment')
  if (!result.ok || !result.blob) return
  const url = URL.createObjectURL(result.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name || path.split('/').pop() || 'download'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
