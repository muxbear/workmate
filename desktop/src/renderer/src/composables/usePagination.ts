import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

/** 每页条数档位（列表类页面的通用档位；会话列表按条数不长，100 已足够） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 10

export interface UsePaginationOptions {
  /** 每页条数档位（默认 PAGE_SIZE_OPTIONS） */
  sizes?: readonly number[]
  /** 初始每页条数（默认 DEFAULT_PAGE_SIZE；有 storageKey 时以本地记录优先） */
  pageSize?: number
  /** 每页条数的本地持久化键（刷新/重启后沿用上次选择） */
  storageKey?: string
}

export interface Pagination<T> {
  /** 当前页（1 起） */
  page: Ref<number>
  /** 每页条数 */
  pageSize: Ref<number>
  /** 档位选项 */
  sizes: readonly number[]
  /** 总条数 */
  total: ComputedRef<number>
  /** 总页数（恒 ≥ 1，空列表也是 1 页） */
  pageCount: ComputedRef<number>
  /** 当前页切片 */
  pageItems: ComputedRef<T[]>
  /** 跳到第 n 页（越界夹取） */
  setPage: (n: number) => void
  /** 上一页 / 下一页（已到边界时为空操作） */
  prev: () => void
  next: () => void
  /** 改每页条数：尽量保持当前首条可见（换算页码），越界回落 */
  setPageSize: (n: number) => void
  /** 回到第 1 页（切换数据源时调用） */
  reset: () => void
}

/**
 * 客户端分页（视图关注点：数据已整份在内存，这里只做切片）。
 *
 * - `total` / `pageCount` 随源列表变化自动重算；页码越界会**自动回落到最后一页**
 *   （删条目后停在空页的场景）
 * - 换数据源（如切换空间）由调用方 `reset()` 回到第 1 页 —— 两种语义分开，避免"删一条就跳回首页"
 */
export function usePagination<T>(source: Ref<T[]>, options: UsePaginationOptions = {}): Pagination<T> {
  const sizes = options.sizes ?? PAGE_SIZE_OPTIONS
  const pageSize = ref(readStoredPageSize(options) ?? options.pageSize ?? DEFAULT_PAGE_SIZE)
  const page = ref(1)

  const total = computed(() => source.value.length)
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const pageItems = computed(() => {
    const start = (page.value - 1) * pageSize.value
    return source.value.slice(start, start + pageSize.value)
  })

  // 越界回落：列表变短（删任务/切空间后条目减少）时不会停在空白页
  watch(pageCount, (count) => {
    if (page.value > count) page.value = count
  })

  function setPage(n: number): void {
    const target = Number.isFinite(n) ? Math.floor(n) : 1
    page.value = Math.min(pageCount.value, Math.max(1, target))
  }

  function prev(): void {
    if (page.value > 1) page.value -= 1
  }

  function next(): void {
    if (page.value < pageCount.value) page.value += 1
  }

  function setPageSize(n: number): void {
    if (!sizes.includes(n) || n === pageSize.value) return
    // 保持当前首条可见：旧页码换算成"首条下标"再折算新页码
    const firstIndex = (page.value - 1) * pageSize.value
    pageSize.value = n
    setPage(Math.floor(firstIndex / n) + 1)
    persistPageSize(options.storageKey, n)
  }

  function reset(): void {
    page.value = 1
  }

  return { page, pageSize, sizes, total, pageCount, pageItems, setPage, prev, next, setPageSize, reset }
}

/** 读本地记录的每页条数（非法/不在档位则忽略） */
function readStoredPageSize(options: UsePaginationOptions): number | null {
  if (!options.storageKey) return null
  const raw = Number(localStorage.getItem(options.storageKey))
  return Number.isInteger(raw) && raw > 0 ? raw : null
}

function persistPageSize(storageKey: string | undefined, size: number): void {
  if (!storageKey) return
  localStorage.setItem(storageKey, String(size))
}
