import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useUiStore } from '@/stores/ui'

/** 拖拽分割线的每次键盘微调步长（px） */
const KEYBOARD_STEP = 24

/**
 * 对话区与右栏之间的分割线拖拽：
 * 按住分割线左右拖动即可改变两侧宽度，宽度状态存放在 ui store。
 */
export function usePanelResize(shellRef: Ref<HTMLElement | null>) {
  const uiStore = useUiStore()
  const dragging = ref(false)
  let observer: ResizeObserver | null = null
  let previousCursor = ''
  let previousUserSelect = ''

  function measureShell() {
    const el = shellRef.value
    if (el) uiStore.syncShellWidth(el.clientWidth)
  }

  function applyClientX(clientX: number) {
    const el = shellRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    uiStore.setRightPanelWidth(rect.right - clientX)
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging.value) return
    event.preventDefault()
    applyClientX(event.clientX)
  }

  function stopDrag() {
    if (!dragging.value) return
    dragging.value = false
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stopDrag)
    window.removeEventListener('pointercancel', stopDrag)
  }

  function onPointerDown(event: PointerEvent) {
    if (uiStore.rightPanelCollapsed || event.button !== 0) return
    event.preventDefault()
    dragging.value = true
    previousCursor = document.body.style.cursor
    previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
  }

  /** 键盘可访问性：←/→ 微调宽度，Home 还原默认宽度 */
  function onKeyDown(event: KeyboardEvent) {
    if (uiStore.rightPanelCollapsed) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      uiStore.setRightPanelWidth(uiStore.rightPanelWidth + KEYBOARD_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      uiStore.setRightPanelWidth(uiStore.rightPanelWidth - KEYBOARD_STEP)
    } else if (event.key === 'Home') {
      event.preventDefault()
      uiStore.resetRightPanelWidth()
    }
  }

  onMounted(() => {
    measureShell()
    if (typeof ResizeObserver !== 'undefined' && shellRef.value) {
      observer = new ResizeObserver(() => measureShell())
      observer.observe(shellRef.value)
    }
  })

  onBeforeUnmount(() => {
    stopDrag()
    observer?.disconnect()
    observer = null
  })

  return { dragging, onPointerDown, onKeyDown, measureShell }
}
