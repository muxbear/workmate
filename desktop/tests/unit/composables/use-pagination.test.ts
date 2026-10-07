import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePagination } from '../../../src/renderer/src/composables/usePagination'

/** 造 n 条数字样本（内容无关，只关心条数与顺序） */
function items(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1)
}

/** localStorage 桩（每页条数持久化用） */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key)
  }
  return store
}

describe('usePagination', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('默认每页 10 条：总页数向上取整，首页切片正确', () => {
    const source = ref(items(25))
    const paged = usePagination(source)
    expect(paged.pageSize.value).toBe(10)
    expect(paged.total.value).toBe(25)
    expect(paged.pageCount.value).toBe(3)
    expect(paged.pageItems.value).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('翻页：末页只取剩余条目；首/末页再翻是空操作', () => {
    const source = ref(items(25))
    const paged = usePagination(source)
    paged.next()
    paged.next()
    expect(paged.page.value).toBe(3)
    expect(paged.pageItems.value).toEqual([21, 22, 23, 24, 25])
    paged.next()
    expect(paged.page.value).toBe(3)
    paged.prev()
    paged.prev()
    paged.prev()
    expect(paged.page.value).toBe(1)
  })

  it('setPage 越界夹取（含 0 / 负数 / 非数字）', () => {
    const source = ref(items(25))
    const paged = usePagination(source)
    paged.setPage(99)
    expect(paged.page.value).toBe(3)
    paged.setPage(0)
    expect(paged.page.value).toBe(1)
    paged.setPage(-5)
    expect(paged.page.value).toBe(1)
    paged.setPage(Number.NaN)
    expect(paged.page.value).toBe(1)
  })

  it('列表变短（删条目）时页码自动回落到最后一页，不停在空页', async () => {
    const source = ref(items(25))
    const paged = usePagination(source)
    paged.setPage(3)
    source.value = items(12)
    await nextTick()
    expect(paged.pageCount.value).toBe(2)
    expect(paged.page.value).toBe(2)
    expect(paged.pageItems.value).toEqual([11, 12])
    // 清空 → 落到唯一的一页，切片为空
    source.value = []
    await nextTick()
    expect(paged.pageCount.value).toBe(1)
    expect(paged.page.value).toBe(1)
    expect(paged.pageItems.value).toEqual([])
  })

  it('reset 回到第 1 页（切换空间语义，与"越界回落"分开）', () => {
    const source = ref(items(25))
    const paged = usePagination(source)
    paged.setPage(3)
    paged.reset()
    expect(paged.page.value).toBe(1)
    expect(paged.pageItems.value).toHaveLength(10)
  })

  it('空列表：总数 0、页数 1、切片为空', () => {
    const paged = usePagination(ref<number[]>([]))
    expect(paged.total.value).toBe(0)
    expect(paged.pageCount.value).toBe(1)
    expect(paged.pageItems.value).toEqual([])
  })

  it('改每页条数：保持当前首条可见（换算页码）', () => {
    const source = ref(items(100))
    const paged = usePagination(source)
    // 第 3 页首条为下标 20（值 21）
    paged.setPage(3)
    expect(paged.pageItems.value[0]).toBe(21)
    paged.setPageSize(20)
    expect(paged.pageSize.value).toBe(20)
    expect(paged.page.value).toBe(2) // 下标 20 → 第 2 页
    expect(paged.pageItems.value[0]).toBe(21)
  })

  it('改每页条数：不在档位内或同值时忽略', () => {
    const source = ref(items(100))
    const paged = usePagination(source)
    paged.setPage(2)
    paged.setPageSize(7)
    expect(paged.pageSize.value).toBe(10)
    expect(paged.page.value).toBe(2)
    paged.setPageSize(10)
    expect(paged.page.value).toBe(2)
  })

  it('每页条数选择写入本地（供下次恢复）', () => {
    const store = stubStorage()
    const paged = usePagination(ref(items(100)), { storageKey: 'ke-work.test.page-size' })
    paged.setPageSize(50)
    expect(store.get('ke-work.test.page-size')).toBe('50')
    // 新实例从本地恢复
    const restored = usePagination(ref(items(100)), { storageKey: 'ke-work.test.page-size' })
    expect(restored.pageSize.value).toBe(50)
  })

  it('自定义档位与初始条数生效；本地记录优先于初始值', () => {
    stubStorage({ 'ke-work.test.custom': '20' })
    const paged = usePagination(ref(items(100)), {
      sizes: [5, 20],
      pageSize: 5,
      storageKey: 'ke-work.test.custom'
    })
    expect(paged.sizes).toEqual([5, 20])
    expect(paged.pageSize.value).toBe(20)
  })

  it('本地记录非法（0 / 非数字）时回落初始值', () => {
    stubStorage({ 'ke-work.test.bad': '0' })
    expect(
      usePagination(ref(items(10)), { pageSize: 20, storageKey: 'ke-work.test.bad' }).pageSize.value
    ).toBe(20)
    stubStorage({ 'ke-work.test.bad2': 'abc' })
    expect(
      usePagination(ref(items(10)), { pageSize: 20, storageKey: 'ke-work.test.bad2' }).pageSize.value
    ).toBe(20)
  })

  it('未传 storageKey 时不触碰 localStorage', () => {
    const store = stubStorage()
    const paged = usePagination(ref(items(100)))
    paged.setPageSize(20)
    expect(store.size).toBe(0)
  })

  it('持久化写入不因环境缺少 localStorage 而炸（有 storageKey 才写）', () => {
    // 有 storageKey 且 localStorage 不存在时的行为由环境保证（渲染层必有），
    // 这里只确认无 key 的调用路径完全不依赖它
    delete (globalThis as Record<string, unknown>).localStorage
    const paged = usePagination(ref(items(100)))
    expect(() => paged.setPageSize(20)).not.toThrow()
    vi.restoreAllMocks()
  })
})
