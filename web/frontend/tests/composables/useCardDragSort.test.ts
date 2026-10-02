import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import {
  blockRangeOf,
  moveWithinBlock,
  useCardDragSort,
} from '@/composables/useCardDragSort'

/**
 * 卡片拖拽排序（浏览器原生拖拽：dragstart → dragover 定落点 → drop 落库）。
 *
 * 三条不变式：
 *
 * 1. **不跨组换位**——列表按「置顶 → 手工顺序」排，跨过置顶边界的顺序刷新后会被
 *    服务端推翻，所以落点先夹取到同组边界；
 * 2. **提交的是整段同组 id**——服务端按"这段在列表里的位置"重编号，少一个或多一个
 *    都会 400（跳段提交会被拒）；
 * 3. **没有拖动时不接管**——其它栏目 / 检索中的卡片不可拖，外部拖入（文件）也不该
 *    被页面拦下。
 *
 * jsdom 24 没有 DragEvent/DataTransfer：事件用 MouseEvent 造（字段够用），
 * dataTransfer 按需以桩注入——生产代码本来就 `if (event.dataTransfer)` 守卫，
 * "没有 dataTransfer"这条路径也要测到。
 */

interface Card {
  id: string
  name: string
  isPinned: boolean
}

function card(id: string, isPinned = false): Card {
  return { id, name: id.toUpperCase(), isPinned }
}

const blockOf = (item: Card) => (item.isPinned ? 'pinned' : 'plain')

describe('拖动排序 · 分组裁剪（纯函数）', () => {
  const list = [card('p', true), card('q', true), card('a'), card('b'), card('c')]

  it('分组区间取同组连续的一段', () => {
    expect(blockRangeOf(list, 0, blockOf)).toEqual([0, 1])
    expect(blockRangeOf(list, 1, blockOf)).toEqual([0, 1])
    expect(blockRangeOf(list, 3, blockOf)).toEqual([2, 4])
  })

  it('越界下标返回空区间', () => {
    expect(blockRangeOf(list, -1, blockOf)).toEqual([-1, -1])
    expect(blockRangeOf(list, 9, blockOf)).toEqual([-1, -1])
  })

  it('组内换位', () => {
    const next = moveWithinBlock(list, 4, 2, blockOf)
    expect(next?.map((i) => i.id)).toEqual(['p', 'q', 'c', 'a', 'b'])
  })

  it('拖到别的组上方时夹回本组边界（不跨置顶）', () => {
    // 拖 c（未置顶组的最后一项）到列表最前：只能落在未置顶组的第一位
    const next = moveWithinBlock(list, 4, 0, blockOf)
    expect(next?.map((i) => i.id)).toEqual(['p', 'q', 'c', 'a', 'b'])
  })

  it('位置没变返回 null（调用方据此跳过落库）', () => {
    expect(moveWithinBlock(list, 2, 2, blockOf)).toBeNull()
    // 单元素分组：无论往哪拖都只能停在原位
    expect(moveWithinBlock([card('p', true), card('a')], 0, 1, blockOf)).toBeNull()
  })
})

/** 用完即弃的宿主组件：把 composable 接到真实 DOM 上 */
function mountHarness(options: { enabled?: boolean; items?: Card[]; axis?: 'x' | 'y' } = {}) {
  const axis = options.axis ?? 'x'
  const items = ref(options.items ?? [card('a'), card('b'), card('c')])
  const committed = ref<string[][]>([])
  const opened = ref<string[]>([])
  const enabled = ref(options.enabled ?? true)

  const Harness = defineComponent({
    setup() {
      const drag = useCardDragSort<Card>({
        items: () => items.value,
        idOf: (kb) => kb.id,
        blockOf,
        enabled: () => enabled.value,
        dropAxis: () => axis,
        onReorder: (ids) => {
          committed.value.push(ids)
        },
      })
      return { ...drag, items, opened, enabled }
    },
    template: `
      <div data-sort-area>
        <div
          v-for="kb in items"
          :key="kb.id"
          :data-card-id="kb.id"
          :draggable="enabled"
          :class="{
            'is-dragging': draggingId === kb.id,
            'is-drop-before': dropTargetId === kb.id && !dropAfter,
            'is-drop-after': dropTargetId === kb.id && dropAfter,
          }"
          @dragstart="onDragStart(kb.id, $event)"
          @dragover="onDragOver(kb.id, $event)"
          @drop.prevent="onDrop"
          @dragend="resetDrag"
          @click="handleClick(() => opened.push(kb.id))"
        >{{ kb.name }}</div>
      </div>
    `,
  })

  const wrapper = mount(Harness)
  // jsdom 没有排版：给每个条目一个假盒子，落点半区才判得了。
  // 网格（axis=x）：一排三张 100x100；列表（axis=y）：一列三行 100x40。
  const els = wrapper.findAll('[data-card-id]')
  els.forEach((item) => {
    const el = item.element as HTMLElement
    el.getBoundingClientRect = () => {
      const siblings = el.parentElement ? [...el.parentElement.children] : []
      const index = Math.max(siblings.indexOf(el), 0)
      const width = 100
      const height = axis === 'x' ? 100 : 40
      const left = axis === 'x' ? index * 100 : 0
      const top = axis === 'x' ? 0 : index * 40
      return {
        left, top, width, height,
        right: left + width, bottom: top + height,
        x: left, y: top, toJSON: () => ({}),
      } as DOMRect
    }
  })

  return { wrapper, items, committed, opened, enabled, axis }
}

type Harness = ReturnType<typeof mountHarness>

function elOf(harness: Harness, id: string) {
  return harness.wrapper.get(`[data-card-id="${id}"]`)
}

/** jsdom 没有 DragEvent：用 MouseEvent 造一个够用的（只读 clientX/Y 与 dataTransfer） */
function dragEvent(
  type: string,
  pos: { x?: number; y?: number } = {},
  dataTransfer?: Record<string, unknown>,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: pos.x ?? 0,
    clientY: pos.y ?? 0,
  })
  if (dataTransfer) {
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  }
  return event
}

/** 悬停目标条目：坐标落在其前半 / 后半区的中心（网格看左右、列表看上下） */
function overTarget(harness: Harness, id: string, half: 'before' | 'after'): Event {
  const rect = elOf(harness, id).element.getBoundingClientRect()
  const ratio = half === 'before' ? 0.25 : 0.75
  const pos =
    harness.axis === 'x'
      ? { x: rect.left + rect.width * ratio, y: rect.top + rect.height / 2 }
      : { x: rect.left + rect.width / 2, y: rect.top + rect.height * ratio }
  return dragEvent('dragover', pos)
}

function dragStart(harness: Harness, id: string, dataTransfer?: Record<string, unknown>) {
  return elOf(harness, id).element.dispatchEvent(dragEvent('dragstart', {}, dataTransfer))
}

describe('拖动排序 · 原生拖拽', () => {
  it('拖到目标后半区，落下提交新顺序', async () => {
    const harness = mountHarness()

    dragStart(harness, 'a')
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    elOf(harness, 'b').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([['b', 'a', 'c']])
  })

  it('拖到目标前半区，落在目标之前', async () => {
    const harness = mountHarness()

    dragStart(harness, 'c')
    elOf(harness, 'a').element.dispatchEvent(overTarget(harness, 'a', 'before'))
    elOf(harness, 'a').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([['c', 'a', 'b']])
  })

  it('列表视图（上下半区）与网格同一套逻辑', async () => {
    const harness = mountHarness({ axis: 'y' })

    dragStart(harness, 'a')
    elOf(harness, 'c').element.dispatchEvent(overTarget(harness, 'c', 'before'))
    elOf(harness, 'c').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([['b', 'a', 'c']])
  })

  it('悬停在别的条目上时打落点标记，换目标只留一个', async () => {
    const harness = mountHarness()

    dragStart(harness, 'a')
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    await nextTick()
    expect(elOf(harness, 'b').classes()).toContain('is-drop-after')

    elOf(harness, 'c').element.dispatchEvent(overTarget(harness, 'c', 'before'))
    await nextTick()
    expect(elOf(harness, 'b').classes()).not.toContain('is-drop-after')
    expect(elOf(harness, 'c').classes()).toContain('is-drop-before')
  })

  it('拖到自己身上不算落点（不 preventDefault、不标记）', async () => {
    const harness = mountHarness()

    dragStart(harness, 'a')
    const accepted = elOf(harness, 'a').element.dispatchEvent(overTarget(harness, 'a', 'after'))

    // 自身不是合法落点：dragover 未 preventDefault（浏览器默认处理滚动等）
    expect(accepted).toBe(true)
    await nextTick()
    expect(elOf(harness, 'a').classes()).not.toContain('is-drop-after')

    elOf(harness, 'a').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()
    expect(harness.committed.value).toEqual([])
  })

  it('越界夹取：未置顶项拖不进置顶区，提交的 ids 不含置顶项', async () => {
    const harness = mountHarness({
      items: [card('p', true), card('q', true), card('a'), card('b')],
    })

    dragStart(harness, 'b')
    elOf(harness, 'p').element.dispatchEvent(overTarget(harness, 'p', 'before'))
    elOf(harness, 'p').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([['b', 'a']])
  })

  it('位置没变就不落库（唯一置顶项拖不出去）', async () => {
    const harness = mountHarness({
      items: [card('p', true), card('a'), card('b')],
    })

    dragStart(harness, 'p')
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    elOf(harness, 'b').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([])
  })

  it('拖拽期间列表被刷新（被拖项消失）时安全放弃', async () => {
    const harness = mountHarness()

    dragStart(harness, 'c')
    harness.items.value = [card('a'), card('b')]
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    elOf(harness, 'b').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([])
  })

  it('有 dataTransfer 时写入 move 效果与 id 兜底', async () => {
    const harness = mountHarness()
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }

    dragStart(harness, 'a', dataTransfer)

    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'a')
    await nextTick()
    expect(elOf(harness, 'a').classes()).toContain('is-dragging')
  })

  it('没有 dataTransfer（jsdom 默认）也能正常拖动', async () => {
    const harness = mountHarness()

    dragStart(harness, 'a')
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    elOf(harness, 'b').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([['b', 'a', 'c']])
  })

  it('dragover 只在有拖动时接管（外部拖文件不拦）', () => {
    const harness = mountHarness()

    // 没有拖拽在途：dragover 未 preventDefault，浏览器按默认处理
    const accepted = elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    expect(accepted).toBe(true)
  })

  it('不允许拖动时（其它分组 / 检索中）drag 全链路没有反应', async () => {
    const harness = mountHarness({ enabled: false })

    const accepted = dragStart(harness, 'c')
    expect(accepted).toBe(true)
    expect(elOf(harness, 'c').classes()).not.toContain('is-dragging')

    elOf(harness, 'a').element.dispatchEvent(overTarget(harness, 'a', 'before'))
    elOf(harness, 'a').element.dispatchEvent(dragEvent('drop'))
    await flushPromises()

    expect(harness.committed.value).toEqual([])
  })

  it('dragend 清掉拖动与落点状态', async () => {
    const harness = mountHarness()

    dragStart(harness, 'a')
    elOf(harness, 'b').element.dispatchEvent(overTarget(harness, 'b', 'after'))
    await nextTick()
    expect(elOf(harness, 'a').classes()).toContain('is-dragging')
    expect(elOf(harness, 'b').classes()).toContain('is-drop-after')

    elOf(harness, 'a').element.dispatchEvent(dragEvent('dragend'))
    await nextTick()
    expect(elOf(harness, 'a').classes()).not.toContain('is-dragging')
    expect(elOf(harness, 'b').classes()).not.toContain('is-drop-after')
  })

  it('拖动后紧随的那次点击被吞掉（不该顺手打开知识库）', async () => {
    vi.useFakeTimers()
    try {
      const harness = mountHarness()

      dragStart(harness, 'c')
      elOf(harness, 'c').element.dispatchEvent(dragEvent('dragend'))
      elOf(harness, 'c').element.dispatchEvent(dragEvent('click'))
      expect(harness.opened.value).toEqual([])

      // 时间窗过后，点击照常生效
      await vi.advanceTimersByTimeAsync(300)
      elOf(harness, 'a').element.dispatchEvent(dragEvent('click'))
      expect(harness.opened.value).toEqual(['a'])
    } finally {
      vi.useRealTimers()
    }
  })
})
