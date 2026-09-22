import {
  artifactBundleUrl,
  artifactDownloadUrl,
  getAccessToken,
} from '@/services/request'

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

/** 带鉴权拉取产物并转为 <img> 可直接使用的对象地址；失败返回 null */
export async function fetchArtifactObjectUrl(
  threadId: string,
  path: string,
): Promise<string | null> {
  if (!threadId || !path) return null
  const result = await fetchArtifactBlob(threadId, path, 'inline')
  if (!result.ok || !result.blob) return null
  return URL.createObjectURL(result.blob)
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


/** 打包下载交付物（本轮或整个会话）；返回是否成功与状态码，由调用方提示 */
export async function downloadBundle(
  threadId: string,
  scope: 'turn' | 'thread' = 'turn',
  turn?: string,
  name?: string,
): Promise<{ ok: boolean; status: number }> {
  if (!threadId) return { ok: false, status: 0 }
  try {
    const response = await fetch(artifactBundleUrl(threadId, scope, turn), {
      headers: { Authorization: 'Bearer ' + (getAccessToken() ?? '') },
    })
    if (!response.ok) return { ok: false, status: response.status }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name || (scope === 'thread' ? '会话交付物.zip' : '本轮交付物.zip')
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return { ok: true, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
