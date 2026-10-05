import { computed, nextTick, ref, watch, type Ref } from 'vue'

/**
 * 对话内搜索（R6：自 NewTaskPage 外提）。
 *
 * 关键词命中正文或思考内容；上一个/下一个沿命中环移动并滚动定位；
 * 定位期间用 `suppressAutoScroll` 抑制底部追滚（页面滚动 watcher 读取该标志，
 * 防「平滑滚动定位」与「流式追底」互相竞争）。
 */

export interface ConversationSearchMessage {
  id: string
  content: string
  reasoning?: string
}

export interface ConversationSearchDeps {
  /** 消息列表（命中与「上一个问题」共用的数据源） */
  messages: Ref<ConversationSearchMessage[]>
}

export function useConversationSearch(deps: ConversationSearchDeps) {
  const searchOpen = ref(false)
  const searchKeyword = ref('')
  const searchIndex = ref(0)
  /** 定位滚动期间抑制自动跟随（页面滚动 watcher 读取） */
  const suppressAutoScroll = ref(false)

  /** 关闭搜索并清空关键词（收敛为方法，避免模板内多语句表达式） */
  const closeSearch = (): void => {
    searchOpen.value = false
    searchKeyword.value = ''
  }

  const searchMatches = computed(() => {
    const kw = searchKeyword.value.trim().toLowerCase()
    if (!kw) return []
    return deps.messages.value.filter(
      (m) => m.content.toLowerCase().includes(kw) || (m.reasoning ?? '').toLowerCase().includes(kw)
    )
  })

  watch(searchKeyword, () => {
    searchIndex.value = 0
  })

  const hitSet = computed(() => new Set(searchMatches.value.map((m) => m.id)))
  const currentHitId = computed(() => searchMatches.value[searchIndex.value]?.id ?? null)

  /** 滚动定位到消息（suppressAutoScroll 防与底部自动滚动竞争） */
  const scrollToMsg = (id: string): void => {
    suppressAutoScroll.value = true
    nextTick(() => {
      document
        .querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setTimeout(() => {
        suppressAutoScroll.value = false
      }, 600)
    })
  }

  const gotoSearch = (dir: 1 | -1): void => {
    const total = searchMatches.value.length
    if (total === 0) return
    searchIndex.value = (searchIndex.value + dir + total) % total
    const target = searchMatches.value[searchIndex.value]
    if (target) scrollToMsg(target.id)
  }

  return {
    searchOpen,
    searchKeyword,
    searchIndex,
    suppressAutoScroll,
    closeSearch,
    searchMatches,
    hitSet,
    currentHitId,
    scrollToMsg,
    gotoSearch
  }
}
