import { onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useMenuConfigStore } from '@/stores/menuConfig'
import type { PermResource } from '@/types/admin'
import type { ResourceDropPlacement } from '@/stores/menuConfig'

const LONG_PRESS_DELAY = 420
const MOVE_CANCEL_THRESHOLD = 6
const SCROLL_EDGE = 36

export function useTreeDrag() {
  const store = useMenuConfigStore()

  const longPressTimer = ref<ReturnType<typeof setTimeout> | null>(null)
  const pointerStart = ref({ x: 0, y: 0 })
  const dragging = ref(false)
  const suppressClick = ref(false)
  const capturedPointerId = ref<number | null>(null)
  const capturedElement = ref<HTMLElement | null>(null)
  let autoScrollFrame: number | null = null

  function clearLongPressTimer() {
    if (longPressTimer.value) {
      clearTimeout(longPressTimer.value)
      longPressTimer.value = null
    }
  }

  function stopAutoScroll() {
    if (autoScrollFrame !== null) {
      cancelAnimationFrame(autoScrollFrame)
      autoScrollFrame = null
    }
  }

  function releasePointerCapture() {
    if (capturedPointerId.value !== null && typeof document !== 'undefined') {
      try {
        document.body.style.userSelect = ''
        capturedElement.value?.releasePointerCapture?.(capturedPointerId.value)
      } catch {
        // ignore
      }
      capturedPointerId.value = null
      capturedElement.value = null
    }
  }

  function resetLocalState() {
    clearLongPressTimer()
    stopAutoScroll()
    releasePointerCapture()
    dragging.value = false
    store.resetDragState()
  }

  function computePlacement(clientY: number, targetEl: HTMLElement): ResourceDropPlacement {
    const rect = targetEl.getBoundingClientRect()
    if (rect.height <= 0) return 'inside'
    const ratio = (clientY - rect.top) / rect.height
    if (ratio < 0.28) return 'before'
    if (ratio > 0.72) return 'after'
    return 'inside'
  }

  function updateDropTarget(clientX: number, clientY: number) {
    if (!store.draggingResource) return

    const source = store.draggingResource
    const targetEl = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-resource-id]')

    if (!targetEl) {
      store.setDropTarget(null, null)
      return
    }

    const targetId = targetEl.dataset.resourceId
    if (!targetId) {
      store.setDropTarget(null, null)
      return
    }

    const target = store.resources.find((r) => r.id === targetId)
    if (!target) {
      store.setDropTarget(null, null)
      return
    }

    const placement = computePlacement(clientY, targetEl)
    if (store.canDropResource(source, target, placement)) {
      store.setDropTarget(targetId, placement)
      return
    }

    if (placement === 'inside') {
      const beforeTarget = store.resources.find(
        (r) => r.parentId === target.parentId && r.id === target.id,
      )
      if (beforeTarget && store.canDropResource(source, target, 'before')) {
        store.setDropTarget(targetId, 'before')
        return
      }
    }

    store.setDropTarget(null, null)
  }

  function autoScroll(treeArea: HTMLElement, clientY: number) {
    stopAutoScroll()
    const rect = treeArea.getBoundingClientRect()
    const scrollBy = () => {
      let delta = 0
      if (clientY - rect.top < SCROLL_EDGE) delta = -10
      else if (rect.bottom - clientY < SCROLL_EDGE) delta = 10

      if (delta !== 0) {
        treeArea.scrollTop += delta
        autoScrollFrame = requestAnimationFrame(scrollBy)
      } else {
        autoScrollFrame = null
      }
    }
    scrollBy()
  }

  function onPointerDown(event: PointerEvent, resource: PermResource) {
    if (!store.draggingEnabled) return

    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea')) return

    const sourceEl = event.currentTarget as HTMLElement | null
    pointerStart.value = { x: event.clientX, y: event.clientY }
    clearLongPressTimer()

    longPressTimer.value = setTimeout(() => {
      longPressTimer.value = null
      dragging.value = true
      suppressClick.value = true
      capturedPointerId.value = event.pointerId
      capturedElement.value = sourceEl
      store.setDraggingResource(resource.id)
      document.body.style.userSelect = 'none'

      if (sourceEl?.setPointerCapture) {
        try {
          sourceEl.setPointerCapture(event.pointerId)
        } catch {
          // ignore capture failure
        }
      }

      updateDropTarget(event.clientX, event.clientY)
    }, LONG_PRESS_DELAY)
  }

  function onPointerMove(event: PointerEvent) {
    if (longPressTimer.value) {
      const moved = Math.hypot(
        event.clientX - pointerStart.value.x,
        event.clientY - pointerStart.value.y,
      )
      if (moved > MOVE_CANCEL_THRESHOLD) {
        clearLongPressTimer()
      }
      return
    }

    if (!dragging.value || !store.draggingResource) return

    updateDropTarget(event.clientX, event.clientY)

    const treeArea = document.querySelector<HTMLElement>('[data-tree-scroll]')
    if (treeArea) {
      autoScroll(treeArea, event.clientY)
    }
  }

  async function onPointerUp(_event?: PointerEvent) {
    if (longPressTimer.value) {
      clearLongPressTimer()
      return
    }

    if (!dragging.value || !store.draggingResource) return

    const sourceId = store.draggingResource.id
    const targetId = store.dropTargetId
    const placement = store.dropPlacement

    resetLocalState()

    if (!targetId || !placement) return

    try {
      await store.moveResource(sourceId, targetId, placement)
    } catch {
      ElMessage.error('资源排序保存失败，已恢复原顺序')
    }
  }

  function onPointerCancel(_event?: PointerEvent) {
    resetLocalState()
  }

  function handleClick(select: () => void) {
    if (suppressClick.value) {
      suppressClick.value = false
      return
    }
    select()
  }

  onUnmounted(() => {
    resetLocalState()
  })

  return {
    dragging,
    suppressClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    handleClick,
  }
}
