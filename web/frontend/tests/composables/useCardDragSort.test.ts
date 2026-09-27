import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import {
  blockRangeOf,
  moveWithinBlock,
  useCardDragSort,
} from '@/composables/useCardDragSort'

/**
 * 卡片拖动排序（长按 → 拖动 → 松手落库）。
 *
 * 两条不变式：
 *
 * 1. **不跨组换位**——列表按「置顶 → 手工顺序」排，跨过置顶边界的顺序刷新后会被
 *    服务端推翻，所以拖动夹在本组内；
 * 2. **提交的是整段同组 id**——服务端按"这段在列表里的位置"重编号，少一个或多一个
 *    都会 400（跳段提交会被拒）。
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
function mountHarness(options: { enabled?: boolean; items?: Card[] } = {}) {
  const items = ref(options.items ?? [card('a'), card('b'), card('c')])
  const committed = ref<string[][]>([])
  const opened = ref<string[]>([])
  const enabled = ref(options.enabled ?? true)

  const Harness = defineComponent({
    setup() {
      const sort = useCardDragSort<Card>({
        items: () => items.value,
        idOf: (kb) => kb.id,
        blockOf,
        enabled: () => enabled.value,
        onReorder: (ids) => {
          committed.value.push(ids)
        },
      })
      return { sort, opened }
    },
    template: `
      <div data-sort-area>
        <div
          v-for="kb in sort.items()"
          :key="kb.id"
          :data-card-id="kb.id"
          @pointerdown="sort.onCardPointerDown($event, kb.id)"
          @click="sort.handleClick(() => opened.push(kb.id))"
        >{{ kb.name }}</div>
      </div>
    `,
  })

  // attachTo：拖动靠 document 上的 pointermove/pointerup 推进，挂在游离节点上的
  // 元素派发的事件传不到 document——必须真挂进文档（与真实用法一致）
  const wrapper = mount(Harness, { attachTo: document.body })
  // jsdom 没有排版：给每个卡片一个假盒子（一排三张，各 100x100），
  // 否则所有 rect 都是 0，"影子压在哪一格上"无从谈起。
  // 桩要**把 transform 算进去**（真浏览器就是如此）：卡片靠位移跟手，落点判定又
  // 要从位移反推它的槽位框，桩不认 transform 就测不出真问题。
  const els = wrapper.findAll('[data-card-id]')
  els.forEach((item) => {
    const el = item.element as HTMLElement
    el.getBoundingClientRect = () => {
      // 位置按**当前的 DOM 次序**现算（一排三格、每格 100x100）：换过位之后布局
      // 真的会变，钉死初始下标的桩会让"换过去又换回来"这种假问题冒出来
      const siblings = el.parentElement ? [...el.parentElement.children] : []
      const index = Math.max(siblings.indexOf(el), 0)
      const moved = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
      const left = index * 100 + (moved ? Number(moved[1]) : 0)
      const top = (moved ? Number(moved[2]) : 0)
      return {
        left, top, width: 100, height: 100,
        right: left + 100, bottom: top + 100,
        x: left, y: top, toJSON: () => ({}),
      } as DOMRect
    }
  })

  return { wrapper, items, committed, opened, enabled }
}

/** jsdom 没有 PointerEvent：用 MouseEvent 造一个够用的（composable 只读这几个字段） */
function pointerEvent(type: string, clientX: number, clientY = 50): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  return event
}

function cardEl(wrapper: ReturnType<typeof mountHarness>['wrapper'], id: string) {
  return wrapper.get(`[data-card-id="${id}"]`)
}

async function longPress(wrapper: ReturnType<typeof mountHarness>['wrapper'], id: string, x: number) {
  cardEl(wrapper, id).element.dispatchEvent(pointerEvent('pointerdown', x))
  await vi.advanceTimersByTimeAsync(500)
}

describe('拖动排序 · 长按拖动', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.style.userSelect = ''
  })

  it('长按后拖到别的卡片上，松手提交新顺序', async () => {
    const { wrapper, committed } = mountHarness()

    await longPress(wrapper, 'c', 250)
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointermove', 10))
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointerup', 10))
    await flushPromises()

    expect(committed.value).toEqual([['c', 'a', 'b']])
  })

  it('刚按下时手抖一下不换位（影子还压在自己身上的回归）', async () => {
    // 之前落点判定把被拖的卡片排除在外，"最近的那张"永远是邻居：长按后手指刚动
    // 一下就先跟邻居换了位。影子还压在自己这一格时，落点必须是自己。
    const { wrapper, committed } = mountHarness()

    await longPress(wrapper, 'a', 50)
    cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('pointermove', 55))
    cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('pointerup', 55))
    await flushPromises()

    expect(committed.value).toEqual([])
  })

  it('影子压到邻居中心才换位，且换完停得住（不来回横跳）', async () => {
    const { wrapper, committed } = mountHarness()

    await longPress(wrapper, 'a', 50)
    // 压到 b 的中心（150）之后才换位
    cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('pointermove', 160))
    await nextTick()   // 真实浏览器里两次 pointermove 之间 DOM 会重排一次
    // 同一位置再动几次：顺序必须稳定，不能换过去又换回来
    for (let i = 0; i < 3; i += 1) {
      cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('pointermove', 160))
      await nextTick()
    }
    cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('pointerup', 160))
    await flushPromises()

    expect(committed.value).toEqual([['b', 'a', 'c']])
  })

  it('提交的只有同组那一段（置顶的卡片不参与）', async () => {
    const { wrapper, committed } = mountHarness({
      items: [card('p', true), card('q', true), card('a'), card('b')],
    })

    // 拖未置顶的 b 到最前面：夹回未置顶组，提交的 ids 不含置顶项
    await longPress(wrapper, 'b', 350)
    cardEl(wrapper, 'b').element.dispatchEvent(pointerEvent('pointermove', 10))
    cardEl(wrapper, 'b').element.dispatchEvent(pointerEvent('pointerup', 10))
    await flushPromises()

    expect(committed.value).toEqual([['b', 'a']])
  })

  it('拖动后位置没变就不落库（唯一置顶项拖不出去）', async () => {
    const { wrapper, committed } = mountHarness({
      items: [card('p', true), card('a'), card('b')],
    })

    // 拖到最右：最近的是 b，但 p 是置顶组里唯一一项，只能停在原位
    await longPress(wrapper, 'p', 10)
    cardEl(wrapper, 'p').element.dispatchEvent(pointerEvent('pointermove', 250))
    cardEl(wrapper, 'p').element.dispatchEvent(pointerEvent('pointerup', 250))
    await flushPromises()

    expect(committed.value).toEqual([])
  })

  it('不允许拖动时（其它分组 / 检索中）长按没有反应', async () => {
    const { wrapper, committed } = mountHarness({ enabled: false })

    await longPress(wrapper, 'c', 250)
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointermove', 10))
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointerup', 10))
    await flushPromises()

    expect(committed.value).toEqual([])
  })

  it('拖动后紧随的那次点击被吞掉（不该顺手打开知识库）', async () => {
    const { wrapper, opened } = mountHarness()

    await longPress(wrapper, 'c', 250)
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointermove', 10))
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointerup', 10))
    await flushPromises()

    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('click', 10))
    expect(opened.value).toEqual([])

    // 下一次点击照常生效
    cardEl(wrapper, 'a').element.dispatchEvent(pointerEvent('click', 10))
    expect(opened.value).toEqual(['a'])
  })

  it('按下后很快移动（当作点击/滚动）不会进入拖动', async () => {
    const { wrapper, committed } = mountHarness()

    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointerdown', 250))
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointermove', 220))
    await vi.advanceTimersByTimeAsync(500)
    cardEl(wrapper, 'c').element.dispatchEvent(pointerEvent('pointerup', 220))
    await flushPromises()

    expect(committed.value).toEqual([])
  })
})
