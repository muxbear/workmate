import { fetchArtifactObjectUrl } from '@/services/artifactApi'

/**
 * 产物对象地址（blob）缓存。
 *
 * 产物下载接口需要 Bearer 鉴权，而浏览器 `<img>` / `<video>` 都无法携带
 * Authorization 头，直接渲染产物地址会 401。统一改为「带鉴权拉取字节 →
 * 生成 blob 对象地址 → 渲染时替换」，因此配图与成片共用同一套缓存：
 * 同一会话同一虚拟路径只拉取一次，跨组件（消息气泡 / 右侧预览）共享，
 * 最后一个使用者卸载时才释放。
 */

/** 已就绪的产物对象地址 */
const objectUrls = new Map<string, string>()
/** 进行中的拉取（并发去重） */
const inflight = new Map<string, Promise<string | null>>()
/** 引用计数：最后一个使用者卸载时释放对象地址 */
const holders = new Map<string, number>()

/** 缓存键（会话 + 虚拟路径） */
export function artifactCacheKey(threadId: string, path: string): string {
  return threadId + '::' + path
}

/** 增加引用计数 */
export function retainArtifactObjectUrl(key: string): void {
  holders.set(key, (holders.get(key) ?? 0) + 1)
}

/** 减少引用计数；归零时释放对象地址 */
export function releaseArtifactObjectUrl(key: string): void {
  const next = (holders.get(key) ?? 0) - 1
  if (next > 0) {
    holders.set(key, next)
    return
  }
  holders.delete(key)
  const url = objectUrls.get(key)
  if (url) {
    URL.revokeObjectURL(url)
    objectUrls.delete(key)
  }
}

/** 取得（必要时拉取）产物对象地址；失败返回 null */
export function loadArtifactObjectUrl(
  key: string,
  threadId: string,
  path: string,
): Promise<string | null> {
  const cached = objectUrls.get(key)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(key)
  if (running) return running
  const task = fetchArtifactObjectUrl(threadId, path)
    .then((url) => {
      if (url) objectUrls.set(key, url)
      return url
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

/**
 * 同步引用计数：把「本次需要的键」与「上次活跃的键」求差，
 * 及时释放不再使用的对象地址。
 *
 * @returns 本次活跃的键集合（供调用方保存为下一次的基线）
 */
export function syncArtifactObjectRefs(
  active: Set<string>,
  keys: Set<string>,
): Set<string> {
  for (const key of active) {
    if (!keys.has(key)) releaseArtifactObjectUrl(key)
  }
  for (const key of keys) {
    if (!active.has(key)) retainArtifactObjectUrl(key)
  }
  return keys
}
