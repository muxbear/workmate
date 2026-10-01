import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useKbQaStore } from '@/stores/kbQa'
import { useUiStore } from '@/stores/ui'

/** 拖拽分割线的每次键盘微调步长（px） */
const KEYBOARD_STEP = 24

/**
 * 知识库内容区与问答区之间的分割线拖拽。
 *
 * 与对话页的 `usePanelResize` 是同一套交互（按住拖动改宽度、←/→ 微调、
 * 双击还原），但**宽度落在 kbQa store 而不是 ui store**：两个页面各有自己的
 * 右栏，在知识库页调宽不该顺手改掉对话页的宽度。
 */
export function useKbQaResize(shellRef: Ref<HTMLElement | null>) {
  const store = useKbQaStore()
  const uiStore = useUiStore()
  const dragging = ref(false)
  let observer: ResizeObserver | null = null
  let previousCursor = ''
  let previousUserSelect = ''

  function measureShell() {
    const el = shellRef.value
    if (el) store.syncShellWidth(el.clientWidth)
  }

  function applyClientX(clientX: number) {
    const el = shellRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 同 usePanelResize：视觉 px → 布局 px。宽度按布局 px 存储（与 clientWidth 同系），
    // 直接塞视觉距离会让字号放大后的分割线不跟手、边界也偏。
    store.setPanelWidth((rect.right - clientX) / uiStore.fontScale)
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
    if (store.collapsed || event.button !== 0) return
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
    if (store.collapsed) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      store.setPanelWidth(store.panelWidth + KEYBOARD_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      store.setPanelWidth(store.panelWidth - KEYBOARD_STEP)
    } else if (event.key === 'Home') {
      event.preventDefault()
      store.resetPanelWidth()
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
