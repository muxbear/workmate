import { artifactDownloadUrl, getAccessToken } from '@/services/request'

/** 带鉴权拉取会话产物内容；失败返回 null，由调用方降级展示 */
export async function fetchArtifactBlob(threadId: string, path: string): Promise<Blob | null> {
  if (!threadId || !path) return null
  const response = await fetch(artifactDownloadUrl(threadId, path), {
    headers: { Authorization: 'Bearer ' + (getAccessToken() ?? '') },
  })
  if (!response.ok) return null
  return await response.blob()
}

/** 下载产物到本地（浏览器触发另存为） */
export async function downloadArtifact(
  threadId: string,
  path: string,
  name: string,
): Promise<void> {
  const blob = await fetchArtifactBlob(threadId, path)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name || path.split('/').pop() || 'download'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
