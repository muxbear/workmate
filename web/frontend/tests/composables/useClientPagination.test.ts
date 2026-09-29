import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useClientPagination } from '@/composables/useClientPagination'

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))

describe('useClientPagination', () => {
  it('按页长切片，total 是整份列表的长度（不是当前页）', () => {
    const source = ref(items(14))
    const { page, pageSize, total, paged } = useClientPagination(source)

    expect(total.value).toBe(14)
    expect(paged.value).toHaveLength(12)
    expect(paged.value[0].id).toBe(1)

    page.value = 2
    expect(paged.value).toHaveLength(2)
    expect(paged.value.map((i) => i.id)).toEqual([13, 14])
  })

  it('改页长后按新页长重新切片', () => {
    const source = ref(items(14))
    const { pageSize, paged } = useClientPagination(source)

    pageSize.value = 6
    expect(paged.value.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('reset 回到第一页（筛选条件变化时用）', () => {
    const source = ref(items(30))
    const { page, paged, reset } = useClientPagination(source)

    page.value = 3
    expect(paged.value[0].id).toBe(25)

    reset()
    expect(page.value).toBe(1)
    expect(paged.value[0].id).toBe(1)
  })

  it('列表变短后自动退回最后一页，不会停在空页', async () => {
    const source = ref(items(30))
    const { page, paged } = useClientPagination(source)

    page.value = 3 // 30 条 / 12 一页 → 第 3 页
    expect(paged.value).toHaveLength(6)

    // 模拟删到只剩 5 条：第 3 页已经不存在了
    source.value = items(5)
    await nextTick()

    expect(page.value).toBe(1)
    expect(paged.value).toHaveLength(5)
  })

  it('空列表不会把页码压到 0 以下', async () => {
    const source = ref(items(0))
    const { page, paged, total } = useClientPagination(source)

    await nextTick()
    expect(total.value).toBe(0)
    expect(page.value).toBe(1)
    expect(paged.value).toEqual([])
  })
})
