import { onUnmounted, ref } from 'vue'

export interface DragSortOptions {
  scope: string
  getItemIds: () => string[]
  onReorder: (orderedIds: string[]) => Promise<void> | void
}

export function useDragSort(options: DragSortOptions) {
  const draggingId = ref<string | null>(null)
  const dropBeforeId = ref<string | null>(null)
  const dropAfterId = ref<string | null>(null)
  let dragPointerId: number | null = null

  function clearDropMarks() {
    dropBeforeId.value = null
    dropAfterId.value = null
  }

  function cleanup() {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerCancel)
    document.body.style.userSelect = ''
    dragPointerId = null
    draggingId.value = null
    clearDropMarks()
  }

  function rowFromPoint(clientX: number, clientY: number): HTMLElement | null {
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (!element) return null
    const row = element.closest<HTMLElement>('[data-drag-row]')
    if (!row) return null
    if (row.dataset.dragScope !== options.scope) return null
    return row
  }

  function handlePointerMove(event: PointerEvent) {
    if (dragPointerId === null || draggingId.value === null) return
    if (event.pointerId !== dragPointerId) return
    event.preventDefault()
    const row = rowFromPoint(event.clientX, event.clientY)
    const sourceId = draggingId.value
    if (!row) {
      clearDropMarks()
      return
    }
    const targetId = row.dataset.dragRowId
    if (!targetId || targetId === sourceId) {
      clearDropMarks()
      return
    }
    const rect = row.getBoundingClientRect()
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    if (placement === 'before') {
      dropBeforeId.value = targetId
      dropAfterId.value = null
    } else {
      dropBeforeId.value = null
      dropAfterId.value = targetId
    }
  }

  async function handlePointerUp(event: PointerEvent) {
    if (dragPointerId === null || draggingId.value === null) return
    if (event.pointerId !== dragPointerId) return
    const sourceId = draggingId.value
    const targetId = dropBeforeId.value ?? dropAfterId.value
    const placement = dropBeforeId.value ? 'before' : 'after'
    cleanup()
    if (!targetId || targetId === sourceId) return

    const ids = options.getItemIds()
    const next = ids.filter((id) => id !== sourceId)
    const targetIndex = next.indexOf(targetId)
    if (targetIndex === -1) return
    const insertIndex = placement === 'before' ? targetIndex : targetIndex + 1
    next.splice(insertIndex, 0, sourceId)
    const unchanged = next.every((id, index) => id === ids[index])
    if (unchanged) return
    try {
      await options.onReorder(next)
    } catch {
      // 错误提示与回滚由调用方负责
    }
  }

  function handlePointerCancel(event: PointerEvent) {
    if (dragPointerId === null) return
    if (event.pointerId !== dragPointerId) return
    cleanup()
  }

  function onHandleDown(event: PointerEvent, id: string) {
    if (event.button !== 0) return
    event.preventDefault()
    dragPointerId = event.pointerId
    draggingId.value = id
    clearDropMarks()
    const target = event.currentTarget as HTMLElement | null
    if (target?.setPointerCapture) {
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // pointer capture 失败时仍通过 window 监听继续拖拽
      }
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  onUnmounted(cleanup)

  return {
    draggingId,
    dropBeforeId,
    dropAfterId,
    onHandleDown,
  }
}
