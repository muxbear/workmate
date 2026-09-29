/**
 * 前端分页：把「已经拿到的整个列表」切成当前页。
 *
 * 为什么是前端分页而不是让后端分页：这几个页面的类型/来源筛选 chips 上的数量、
 * 以及「只显示当前分类下有数据的项」这类逻辑，都是**基于整份列表**算出来的。
 * 一旦改成后端分页，每页只拿到一页的数据，这些计数就会变成「本页的数量」——
 * 数字不报错但全错，是最难被发现的那类问题。而这几页的数据量本来就小
 * （工具 14、技能 6、专家 4），整份加载完全够用。
 *
 * 用法：
 *   const { page, pageSize, total, paged, reset } = useClientPagination(filtered)
 *   // 模板里 v-for="item in paged"，筛选条件一变就调 reset()
 */
import { computed, ref, watch, type Ref } from 'vue'
import { DEFAULT_PAGE_SIZE } from '@/types/pagination'

export function useClientPagination<T>(items: Ref<T[]>, defaultPageSize = DEFAULT_PAGE_SIZE) {
  const page = ref(1)
  const pageSize = ref<number>(defaultPageSize)

  const total = computed(() => items.value.length)

  const paged = computed(() => {
    const start = (page.value - 1) * pageSize.value
    return items.value.slice(start, start + pageSize.value)
  })

  /** 回到第一页（筛选/搜索条件变化时调用） */
  function reset(): void {
    page.value = 1
  }

  // 删到当前页空了（比如删掉本页最后一条）就往前退一页，别停在一个空页上
  watch([total, pageSize], () => {
    const lastPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (page.value > lastPage) page.value = lastPage
  })

  return { page, pageSize, total, paged, reset }
}
