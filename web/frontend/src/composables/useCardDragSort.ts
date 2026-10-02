import { ref } from 'vue'

/**
 * 卡片 / 列表行的拖拽排序（浏览器原生 HTML5 拖拽，与桌面版「本地知识库」列表同一套做法）。
 *
 * 调用方在条目上绑定 `:draggable` 与 dragstart / dragover / drop / dragend 四个钩子，
 * 本 composable 只管拖拽状态与落库计算：
 *
 * 1. **拖动即拖，没有长按**——整块条目就是拖拽面，六点抓手只是视觉提示；
 * 2. **落点用插入线指示，不做实时换位**——原生 DnD 不会替我们挪 DOM，`dataTransfer`
 *    只写 id 兜底（部分平台不写数据会直接取消拖拽）；
 * 3. **只在同一「分组」内换位**（列表按 置顶 → 手工顺序 排，跨过分组边界的顺序刷新后
 *    会被服务端推翻），提交给服务端的也只是被拖动那一段（同组连续段，后端硬校验）。
 *
 * 已知取舍：触屏浏览器对原生拖拽支持不稳（移动端可能拖不动）——这是与桌面版实现
 * 对齐的代价，桌面版（Electron）不受影响。
 */

/** `index` 所在分组在列表里的下标区间（列表里同组元素连续） */
export function blockRangeOf<T>(
  list: T[],
  index: number,
  blockOf: (item: T) => string,
): [number, number] {
  if (index < 0 || index >= list.length) return [-1, -1]
  const key = blockOf(list[index])
  let start = index
  let end = index
  while (start > 0 && blockOf(list[start - 1]) === key) start -= 1
  while (end < list.length - 1 && blockOf(list[end + 1]) === key) end += 1
  return [start, end]
}

/**
 * 把 `from` 处的元素移到 `to`，**越界夹到同组边界**；没有变化时返回 null。
 *
 * 返回新数组而不是原地改：拖动期间要能一眼看出"这次移动是否真的改变了顺序"，
 * 没变就不必打接口。
 */
export function moveWithinBlock<T>(
  list: T[],
  from: number,
  to: number,
  blockOf: (item: T) => string,
): T[] | null {
  const [start, end] = blockRangeOf(list, from, blockOf)
  if (start < 0) return null
  const target = Math.min(Math.max(to, start), end)
  if (target === from) return null
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

/**
 * 拖动刚结束时部分浏览器会补发一次 click：这个窗口内的 click 不当"打开"处理。
 *
 * 原生拖拽大多数情况下直接吞掉 click，这是兜底——人不会在松开拖拽后 200ms 内真的
 * 想再点一下。
 */
const DRAG_END_CLICK_WINDOW = 200

export interface CardDragSortOptions<T> {
  /** 当前列表（drop 时现取：拖拽期间列表被刷新也能安全换算下标） */
  items: () => T[]
  idOf: (item: T) => string
  /** 分组键：只有同组条目能互相换位 */
  blockOf: (item: T) => string
  /** 是否允许拖动（分组页 / 是否正在筛选 / 是否在加载）——`:draggable` 之外的双保险 */
  enabled: () => boolean
  /** 落点前后半区按哪个轴判：网格里卡片排成行 → 'x'；单列列表 → 'y' */
  dropAxis: () => 'x' | 'y'
  /** 落库：提交被拖动那一段（同组、连续）的新顺序 */
  onReorder: (ids: string[]) => Promise<void> | void
}

export function useCardDragSort<T>(options: CardDragSortOptions<T>) {
  /** 正在拖动的条目 id（null = 没有拖动） */
  const draggingId = ref<string | null>(null)
  /** 当前落点：目标条目 id + 落在其前 / 后（插入线画在哪侧） */
  const dropTargetId = ref<string | null>(null)
  const dropAfter = ref(false)
  /** 最近一次拖动结束的时间戳：给紧随其后补发的 click 用（见 DRAG_END_CLICK_WINDOW） */
  let dragEndedAt = 0

  function resetDrag() {
    if (draggingId.value) dragEndedAt = Date.now()
    draggingId.value = null
    dropTargetId.value = null
    dropAfter.value = false
  }

  function onDragStart(id: string, event: DragEvent) {
    if (!options.enabled() || draggingId.value) return
    draggingId.value = id
    dropTargetId.value = null
    dropAfter.value = false
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      // 不写数据时部分平台会直接取消拖拽，写入 id 兜底
      event.dataTransfer.setData('text/plain', id)
    }
  }

  /** 悬停判定落点：网格按左右半区，列表按上下半区 */
  function onDragOver(id: string, event: DragEvent) {
    // 外部拖入（拖文件等）不接管：不 preventDefault，浏览器按默认处理
    if (!draggingId.value || !options.enabled()) return
    if (id === draggingId.value) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropTargetId.value = id
    dropAfter.value =
      options.dropAxis() === 'x'
        ? event.clientX - rect.left > rect.width / 2
        : event.clientY - rect.top > rect.height / 2
  }

  /** 落下：把落点换算成新顺序并落库（置顶区不可跨越，越界先夹取） */
  async function onDrop() {
    const source = draggingId.value
    const target = dropTargetId.value
    const after = dropAfter.value
    resetDrag() // 先复位：提交期间不再显示插入线，失败时正好回到旧顺序
    if (!source || !target || source === target || !options.enabled()) return
    const list = options.items()
    const from = list.findIndex((item) => options.idOf(item) === source)
    const targetIndex = list.findIndex((item) => options.idOf(item) === target)
    // 拖拽期间列表被刷新 / 翻页 / 删除：下标对不上，静默放弃（不拿过期下标落库）
    if (from === -1 || targetIndex === -1) return
    // 落点在目标之前 / 之后；拖动项被摘除后，其后面的下标整体前移一位
    let to = after ? targetIndex + 1 : targetIndex
    if (from < to) to -= 1
    const next = moveWithinBlock(list, from, to, options.blockOf)
    if (!next) return // 夹取回原位：顺序没变，不必打接口
    // 提交的必须是**同一批**同组 id（拖动只换位、不增删）——服务端按"这段在列表里
    // 的位置"重编号，少一个或多一个都会被拒
    const block = options.blockOf(list[from])
    const ids = next
      .filter((item) => options.blockOf(item) === block)
      .map((item) => options.idOf(item))
    try {
      await options.onReorder(ids)
    } catch {
      // 错误提示与回滚（重取列表）由调用方负责
    }
  }

  /** 条目点击统一走这里：拖动刚结束时补发的 click 被吞掉 */
  function handleClick(action: () => void) {
    if (Date.now() - dragEndedAt < DRAG_END_CLICK_WINDOW) return
    action()
  }

  return {
    draggingId,
    dropTargetId,
    dropAfter,
    onDragStart,
    onDragOver,
    onDrop,
    resetDrag,
    handleClick,
  }
}
