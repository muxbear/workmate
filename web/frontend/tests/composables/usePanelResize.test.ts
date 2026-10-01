import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, onMounted, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelResize } from '@/composables/usePanelResize'
import { useUiStore } from '@/stores/ui'

/**
 * 分割线拖拽的坐标换算。
 *
 * 字号偏好给根元素加了 `zoom`，于是页面里同时存在两套坐标：
 *
 * - **视觉 px**：`getBoundingClientRect()`、`MouseEvent.clientX`（会被 zoom 放大）
 * - **布局 px**：`clientWidth`、CSS `width`（不受祖先 zoom 影响）
 *
 * 右栏宽度按布局 px 存储与渲染，而指针位置是视觉 px。混用的话，字号一放大
 * 分割线就会跑得比指针快 zoom 倍、钳制上下界也偏——这正是当初把字号方案
 * 定为 go/no-go 关卡要验的东西。
 */

/** 让宿主的 clientWidth / getBoundingClientRect 可控：800 布局宽 × zoom = 视觉宽 */
function mountResize(zoom: number) {
  let api: ReturnType<typeof usePanelResize> | null = null

  const Host = defineComponent({
    setup() {
      const el: Ref<HTMLElement | null> = ref(null)
      const resize = usePanelResize(el)
      api = resize
      onMounted(() => {
        const node = el.value
        if (!node) return
        Object.defineProperty(node, 'clientWidth', { value: 800, configurable: true })
        Object.defineProperty(node, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            right: 800 * zoom,
            left: 0,
            top: 0,
            bottom: 600,
            width: 800 * zoom,
            height: 600,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }),
        })
      })
      return () => h('div', { ref: el, onPointerdown: resize.onPointerDown })
    },
  })

  const wrapper = mount(Host)
  // 本组件的 onMounted 晚于 composable 自己的——后者测到的还是 jsdom 里真实的
  // clientWidth(0)。桩装好之后显式同步一次，shellWidth 才是 800。
  const resize = api as unknown as ReturnType<typeof usePanelResize>
  resize.measureShell()
  return { wrapper, api: resize }
}

/**
 * jsdom 的 PointerEvent 支持不全，用 Event 补上 handler 真正读取的字段。
 *
 * 尤其是 `button`：`onPointerDown` 里判 `event.button !== 0` 就直接返回，
 * 而 `wrapper.trigger('pointerdown')` 走的是 Event 构造器，button 会丢成
 * undefined——那样拖拽压根不会开始，测试却只看到"宽度没变"。
 */
function firePointer(type: 'pointerdown' | 'pointermove', init: { button?: number; clientX?: number }) {
  const event = new Event(type) as Event & { button?: number; clientX?: number }
  if (init.button !== undefined) event.button = init.button
  if (init.clientX !== undefined) event.clientX = init.clientX
  Object.defineProperty(event, 'preventDefault', { value: () => {} })
  return event
}

function startDrag(el: Element) {
  el.dispatchEvent(firePointer('pointerdown', { button: 0 }))
}

function movePointer(clientX: number) {
  window.dispatchEvent(firePointer('pointermove', { clientX }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  // tests/setup.ts 里 localStorage 是跨用例共享的 mock，字号会带着上一用例的值
  window.localStorage.clear()
  document.documentElement.style.removeProperty('zoom')
})

describe('拖拽分割线', () => {
  it('未缩放时宽度就等于指针到右边缘的距离', () => {
    const ui = useUiStore()
    ui.rightPanelCollapsed = false // 收起状态下分割线不响应拖拽
    const { wrapper } = mountResize(1)

    startDrag(wrapper.element)
    movePointer(500) // 视觉右边缘 800，距离 300

    expect(ui.rightPanelWidth).toBe(300)
    wrapper.unmount()
  })

  it('字号放大后仍按视觉距离换算，分割线跟手而不是跑得更快', () => {
    const ui = useUiStore()
    ui.rightPanelCollapsed = false
    ui.setFontSize(24) // zoom = 24/17 ≈ 1.4118
    const zoom = ui.fontScale
    const { wrapper } = mountResize(zoom)

    startDrag(wrapper.element)
    // 指针距视觉右边缘 400px（视觉右边缘 = 800 * zoom）。
    // 取 400 而不是 300：换算回布局 px 后是 283，落在 [240, 440] 内，
    // 不会被最小/最大宽度钳制，量到的才是纯粹的换算结果。
    movePointer(800 * zoom - 400)

    // 存的是布局 px，但换算成视觉后必须还原成 400——这才叫跟手。
    // 容差 ≤1px：宽度在 store 里按整数存储（clampRightPanelWidth 会 Math.round）
    expect(Math.abs(ui.rightPanelWidth * zoom - 400)).toBeLessThanOrEqual(1)
    expect(Math.abs(ui.rightPanelWidth - 400 / zoom)).toBeLessThanOrEqual(1)
    wrapper.unmount()
  })

  it('缩放系数为 1 时不引入任何偏差', () => {
    const ui = useUiStore()
    expect(ui.fontScale).toBe(1)
  })
})
