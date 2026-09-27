import { nextTick, onUnmounted, ref, type Ref } from 'vue'

/**
 * 卡片 / 列表行的长按拖动排序（容器上标 `data-sort-area`，条目上标 `data-card-id`）。
 *
 * `data-sort-area` 只要求"条目按 DOM 顺序排布"——网格、单列列表都行，落点判定按
 * 影子中心压在哪一格的框上来算，与行列数无关。
 *
 * 与列表拖拽（`useDragSort`，手柄即时生效）的区别：
 *
 * 1. **长按才进入拖动**——卡片整张都是点击区（点开知识库），即时拖动会把点击
 *    变成"手一抖就换位置"。长按时长与 `useTreeDrag` 一致，长按语义全站一套。
 * 2. **拖动期间本地重排**（卡片跟手、其它卡片让位），松手才落库——网格里用插入
 *    线指示落点很难看清插在哪两格之间。
 * 3. **只在同一"分组"内换位**：列表按 置顶 → 手工顺序 排，跨过分组边界拖出去的
 *    顺序在刷新后会被服务端推翻（置顶的永远在最前），所以拖动范围夹在分组内部，
 *    提交给服务端的也只是这一段。
 */

/** 长按判定时长：与 useTreeDrag 一致——长按语义在两处必须一样 */
const LONG_PRESS_DELAY = 420
/**
 * 长按等待期间的移动容差：超过就当成点击/滚动，不再进入拖动。
 *
 * 比 useTreeDrag 的 6px 松一点：卡片整张都可点，按下时手抖一两下是常态，
 * 容差太小会让"明明按住了却怎么也不进入拖动"。
 */
const MOVE_CANCEL_THRESHOLD = 10

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

export interface CardDragSortOptions<T> {
  /** 当前列表（顺序即服务端返回的顺序） */
  items: () => T[]
  idOf: (item: T) => string
  /** 分组键：只有同组卡片能互相换位 */
  blockOf: (item: T) => string
  /** 是否允许拖动（分组页 / 是否正在筛选 / 是否在加载） */
  enabled: () => boolean
  /** 落库：提交被拖动那一段（同组、连续）的新顺序 */
  onReorder: (ids: string[]) => Promise<void> | void
}

export function useCardDragSort<T>(options: CardDragSortOptions<T>) {
  /** 拖动期间的本地顺序；不在拖动时为 null（渲染走服务端顺序） */
  const order: Ref<T[] | null> = ref(null) as Ref<T[] | null>
  const draggingId = ref<string | null>(null)
  /** 长按/拖动刚结束：紧随其后的 click 不该打开知识库 */
  const suppressClick = ref(false)

  let pointerId: number | null = null
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let pressStart = { x: 0, y: 0 }
  let cardEl: HTMLElement | null = null
  let gridEl: HTMLElement | null = null
  /** 按下点相对卡片左上角的偏移：跟手时保持这个偏移，卡片才不会"跳一下" */
  let grabOffset = { x: 0, y: 0 }
  /** 当前挂在被拖卡片上的位移（需要反推它的槽位框，见 slotRectOfDragged） */
  let ghostShift = { x: 0, y: 0 }

  function clearPress() {
    if (pressTimer !== null) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }

  function releasePointer() {
    clearPress()
    if (pointerId !== null && cardEl?.releasePointerCapture) {
      try {
        cardEl.releasePointerCapture(pointerId)
      } catch {
        // 捕获已被浏览器释放：忽略
      }
    }
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
    document.removeEventListener('pointercancel', handlePointerCancel)
    pointerId = null
  }

  /** 清掉跟手的位移与层级，并把渲染交还给服务端顺序 */
  function resetDrag() {
    if (cardEl) {
      cardEl.style.transform = ''
      cardEl.style.zIndex = ''
    }
    cardEl = null
    gridEl = null
    ghostShift = { x: 0, y: 0 }
    draggingId.value = null
    order.value = null
    document.body.style.userSelect = ''
  }

  function sortableCards(): HTMLElement[] {
    if (!gridEl) return []
    return [...gridEl.querySelectorAll<HTMLElement>('[data-card-id]')]
  }

  /**
   * 影子中心：落点判据用它，而不是指针位置。
   *
   * 指针通常停在卡片的边角上（按住哪儿就从哪儿拖），而"该插到第几格"说的其实是
   * **卡片中心**到了哪儿——差半张卡的误差会让落点早一格或晚一格。
   */
  function ghostCenter(clientX: number, clientY: number) {
    const rect = cardEl?.getBoundingClientRect()
    return {
      x: clientX - grabOffset.x + (rect?.width ?? 0) / 2,
      y: clientY - grabOffset.y + (rect?.height ?? 0) / 2,
    }
  }

  /**
   * 被拖卡片的**槽位**框（不是跟着指针跑的影子框）。
   *
   * 卡片身上只挂了一个平移（见 `followPointer`），减掉它就是这个元素在布局里
   * 占的那一格。落点判定必须用槽位框：影子框跟着指针走，用它自己会永远"压在自己
   * 身上"。
   */
  function slotRectOfDragged(): DOMRect | null {
    if (!cardEl) return null
    const rect = cardEl.getBoundingClientRect()
    return new DOMRect(
      rect.left - ghostShift.x,
      rect.top - ghostShift.y,
      rect.width,
      rect.height,
    )
  }

  /**
   * 落点槽位：**影子中心压在哪一格上**（压不到任何格子时取中心最近的那格）。
   *
   * 被拖的那张也要参与判定，用的是它的槽位框：影子还在自己那一格上时，落点就是
   * 自己（`to === from`，不换位）。**之前正是这里出错**——判定时把被拖的卡片排除
   * 在外，于是"离影子最近的那张"永远是旁边的邻居，长按后手指刚动一下就先跟邻居
   * 换了个位；换过去之后布局一变，最近的那张又变回原来那位，来回横跳。
   */
  function slotIndexAt(clientX: number, clientY: number, list: T[]): number {
    const center = ghostCenter(clientX, clientY)
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (const el of sortableCards()) {
      const id = el.dataset.cardId
      if (!id) continue
      const index = list.findIndex((item) => options.idOf(item) === id)
      if (index === -1) continue
      const rect = el === cardEl ? slotRectOfDragged() : el.getBoundingClientRect()
      if (!rect) continue
      const inside =
        center.x >= rect.left && center.x <= rect.right &&
        center.y >= rect.top && center.y <= rect.bottom
      if (inside) return index
      const dx = center.x - (rect.left + rect.width / 2)
      const dy = center.y - (rect.top + rect.height / 2)
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }

  /** 拖动中的卡片跟着指针走：按它**当前槽位**的框算位移，重排后要重算一次 */
  function followPointer(clientX: number, clientY: number) {
    if (!cardEl) return
    const rect = cardEl.getBoundingClientRect()
    ghostShift = {
      x: clientX - grabOffset.x - rect.left,
      y: clientY - grabOffset.y - rect.top,
    }
    cardEl.style.transform = `translate(${ghostShift.x}px, ${ghostShift.y}px)`
  }

  function reorderAt(clientX: number, clientY: number) {
    const current = order.value
    const sourceId = draggingId.value
    if (!current || !sourceId) return
    const from = current.findIndex((item) => options.idOf(item) === sourceId)
    if (from === -1) return
    const to = slotIndexAt(clientX, clientY, current)
    // 影子还在自己那一格里：不换位
    if (to === -1 || to === from) return
    const next = moveWithinBlock(current, from, to, options.blockOf)
    if (!next) return
    order.value = next
    // 槽位变了：位移基准跟着变，等 DOM 落定再算，否则会闪一帧
    void nextTick(() => followPointer(clientX, clientY))
  }

  async function commit() {
    const current = order.value
    const sourceId = draggingId.value
    const sourceItem = current?.find((item) => options.idOf(item) === sourceId)
    const baseline = options.items()
    if (!current || !sourceItem) {
      resetDrag()
      return
    }

    const block = options.blockOf(sourceItem)
    const ids = current
      .filter((item) => options.blockOf(item) === block)
      .map((item) => options.idOf(item))
    // 提交的必须是**同一批** id（拖动只换位、不增删）；对不上说明中途列表被刷新过，
    // 这时提交出去的是别的一批库，服务端要么 400、要么按它的理解改错顺序
    const before = baseline
      .filter((item) => options.blockOf(item) === block)
      .map((item) => options.idOf(item))
    const sameSet = ids.length === before.length

    draggingId.value = null
    if (!sameSet || ids.every((id, i) => id === before[i])) {
      resetDrag()
      return
    }
    try {
      await options.onReorder(ids)
    } finally {
      // 无论成败都交还服务端顺序：失败时正好回到旧顺序（调用方负责提示）
      resetDrag()
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    if (!draggingId.value) {
      const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y)
      if (moved > MOVE_CANCEL_THRESHOLD) releasePointer()
      return
    }
    event.preventDefault()
    reorderAt(event.clientX, event.clientY)
    followPointer(event.clientX, event.clientY)
  }

  function handlePointerUp(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    releasePointer()
    if (draggingId.value) void commit()
  }

  function handlePointerCancel(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return
    releasePointer()
    resetDrag()
  }

  function items(): T[] {
    return order.value ?? options.items()
  }

  function onCardPointerDown(event: PointerEvent, id: string) {
    if (draggingId.value || !options.enabled()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    // 卡片上的按钮（三点菜单、标签内的交互）不参与拖动
    if ((event.target as HTMLElement | null)?.closest('button, input, select, textarea, a')) return

    const el = event.currentTarget as HTMLElement | null
    if (!el) return
    cardEl = el
    gridEl = el.closest<HTMLElement>('[data-sort-area]')
    pointerId = event.pointerId
    pressStart = { x: event.clientX, y: event.clientY }

    clearPress()
    pressTimer = setTimeout(() => {
      pressTimer = null
      const rect = el.getBoundingClientRect()
      grabOffset = { x: pressStart.x - rect.left, y: pressStart.y - rect.top }
      order.value = [...options.items()]
      draggingId.value = id
      suppressClick.value = true
      el.style.zIndex = '5'
      document.body.style.userSelect = 'none'
      if (el.setPointerCapture) {
        try {
          el.setPointerCapture(event.pointerId)
        } catch {
          // 捕获失败时仍靠 window 监听继续拖
        }
      }
    }, LONG_PRESS_DELAY)

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
  }

  /** 卡片点击统一走这里：拖动刚结束时吞掉那次 click */
  function handleClick(action: () => void) {
    if (suppressClick.value) {
      suppressClick.value = false
      return
    }
    action()
  }

  onUnmounted(() => {
    releasePointer()
    document.body.style.userSelect = ''
  })

  return {
    draggingId,
    items,
    onCardPointerDown,
    handleClick,
  }
}
