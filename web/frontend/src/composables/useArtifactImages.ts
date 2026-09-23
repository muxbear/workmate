import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  artifactCacheKey as cacheKey,
  loadArtifactObjectUrl as load,
  releaseArtifactObjectUrl as release,
  retainArtifactObjectUrl as retain,
  syncArtifactObjectRefs,
} from '@/utils/artifactObjectCache'
import {
  extractImageSources,
  resolveArtifactImage,
  type MarkdownImageContext,
} from '@/utils/markdownArtifacts'

/**
 * 文章配图的「带鉴权加载」。
 *
 * 产物下载接口需要 Bearer 鉴权，而浏览器 <img> 无法携带 Authorization 头，
 * 直接渲染产物地址会 401 裂图（消息气泡与右侧预览都会命中）。这里统一改为
 * 「带鉴权拉取字节 → 生成 blob 对象地址 → 渲染时替换」，并在同一会话内共享缓存
 * （缓存实现见 `@/utils/artifactObjectCache`，与成片加载共用）。
 */

/** 鉴权图片就绪前的占位图（1×1 透明），避免闪现裂图 */
export const PENDING_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** 配图加载句柄：给自定义 Markdown 渲染器使用 */
export interface ArtifactImages {
  /** 原始图片地址 → 已就绪的 blob 对象地址 */
  sources: Ref<Record<string, string>>
  /** 加载失败的原始图片地址（渲染时回退到产物地址，暴露可见的失败） */
  failed: Ref<Record<string, true>>
  /** 渲染用地址：已就绪 blob > 加载中占位 > 回退（失败或非产物） */
  renderSrc: (raw: string, fallback: Record<string, string>) => string
}

/**
 * 跟踪一段 Markdown 中的配图并按需带鉴权加载。
 *
 * @param getMarkdown 取当前 Markdown 文本（变化时自动重新解析）
 * @param getContext 取解析上下文（threadId / basePath / 产物清单）
 * @returns 渲染句柄；组件卸载时自动释放对象地址
 */
export function useArtifactImages(
  getMarkdown: () => string,
  getContext: () => MarkdownImageContext,
): ArtifactImages {
  const sources = ref<Record<string, string>>({})
  const failed = ref<Record<string, true>>({})
  let active = new Set<string>()
  let disposed = false

  async function refresh(): Promise<void> {
    const context = getContext()
    const targets = new Map<string, { key: string; threadId: string; path: string }>()
    for (const raw of extractImageSources(getMarkdown())) {
      const resolved = resolveArtifactImage(raw, context)
      if (!resolved) continue
      targets.set(raw, {
        key: cacheKey(resolved.threadId, resolved.path),
        threadId: resolved.threadId,
        path: resolved.path,
      })
    }

    // 依赖变化时同步引用计数：不再需要的地址及时释放
    const keys = new Set(Array.from(targets.values(), (item) => item.key))
    active = syncArtifactObjectRefs(active, keys)

    if (targets.size === 0) {
      if (!disposed) {
        sources.value = {}
        failed.value = {}
      }
      return
    }

    const loaded: Record<string, string> = {}
    const missed: Record<string, true> = {}
    await Promise.all(
      Array.from(targets.entries(), async ([raw, item]) => {
        const url = await load(item.key, item.threadId, item.path)
        if (url) loaded[raw] = url
        else missed[raw] = true
      }),
    )
    if (disposed) return
    sources.value = loaded
    failed.value = missed
  }

  watch(
    () => {
      const context = getContext()
      return [
        getMarkdown(),
        context.threadId ?? '',
        context.basePath ?? '',
        (context.artifactPaths ?? []).join('|'),
      ].join('\u0000')
    },
    () => void refresh(),
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    for (const key of active) release(key)
    active = new Set()
  })

  function renderSrc(raw: string, fallback: Record<string, string>): string {
    const ready = sources.value[raw]
    if (ready) return ready
    const target = fallback[raw]
    if (!target) return raw
    return failed.value[raw] ? target : PENDING_IMAGE_PLACEHOLDER
  }

  return { sources, failed, renderSrc }
}
