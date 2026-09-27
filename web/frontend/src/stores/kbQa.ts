import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { KBDoc, KB, SearchResult } from '@/types/knowledgeBase'
import { fetchKBPage, readApiError, searchKnowledgeBase } from '@/services/knowledgeBaseApi'
import { createEmptySelection } from '@/types/chat'
import { sendStreamRequest } from '@/services/request'

/**
 * 知识库页右侧「问答」区的状态。
 *
 * 与对话页的 `ui` + `workspace` 两个 store 承担的角色对应（那边是「历史对话」+
 * 文档标签页、外加右栏宽度），但**刻意不复用它们**：
 *
 * - 宽度与折叠态是页面级的：在知识库页把问答区调宽，不该顺手改掉对话页右栏的宽度；
 * - 标签页集合也不一样：这里的固定首标签是「问答」，其余是知识库文档的预览。
 *
 * 会话本身也留在这里（消息、来源、流式开关），因为问答面板是**一个**长期存在的
 * 会话——切标签、切知识库都不应该把它清掉。
 */

/** 「问答」标签的 key：面板的常驻首标签，不可关闭 */
export const QA_TAB_KEY = 'qa'

/** 问答区展开时的默认宽度（px） */
export const DEFAULT_KB_QA_WIDTH = 440
/** 问答区最小宽度（px） */
export const MIN_KB_QA_WIDTH = 320
/** 问答区折叠后的轨道宽度（px） */
export const KB_QA_COLLAPSED_WIDTH = 40
/** 知识库内容区的最小宽度（px），拖拽分割线时用来约束问答区的最大宽度 */
export const MIN_KB_CONTENT_WIDTH = 460

/** 把问答区宽度约束到 [最小宽度, 容器宽度 - 内容区最小宽度] */
export function clampKbQaWidth(width: number, shellWidth: number): number {
  if (shellWidth <= 0) return Math.max(Math.round(width), MIN_KB_QA_WIDTH)
  const max = Math.max(MIN_KB_QA_WIDTH, shellWidth - MIN_KB_CONTENT_WIDTH)
  return Math.round(Math.min(Math.max(width, MIN_KB_QA_WIDTH), max))
}

/**
 * 一个**文档预览**标签页。
 *
 * 「问答」标签不在这里：它是常驻的首标签，由面板直接渲染，不参与这个集合
 * （于是"删到只剩它"这类状态压根不存在）。
 */
export interface KbQaTab {
  /** `doc:{kbId}:{docId}`——同一个文档在同一个库里只占一个标签 */
  key: string
  title: string
  /** 所属知识库 */
  kbId: string
  /**
   * 文档快照。
   *
   * 存快照而不是只存 id：文档列表会分页、会被 SSE 与轮询整体替换，只存 id 时
   * 翻页之后这个标签就取不到文档了（标题与统计会变空）。预览内容是切片，与
   * 列表状态无关，快照不会过期到影响阅读。
   */
  doc: KBDoc
}

/** 一问一答中的一轮 */
export interface KbQaTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 该轮回答依据的检索结果（仅 assistant 轮） */
  sources: SearchResult[]
  /** 检索判定「库中没有相关内容」——与"检索失败"是两回事 */
  noRelevant: boolean
  /** 检索失败原因（检索挂了仍会带问题去问模型，但必须留痕） */
  retrieveError: string
  /** 回答正在生成中 */
  pending: boolean
  /** 生成失败原因 */
  error: string
}

let seq = 0
function nextId(): string {
  seq += 1
  return `qa-${Date.now()}-${seq}`
}

/**
 * 把检索结果拼成给模型的上下文。
 *
 * 没有命中时不编造上下文，直接把问题原样送出去——那一步的意义是让模型能按自己的
 * 知识回答，而不是对着空上下文硬说"无法回答"。
 */
export function buildQaPrompt(question: string, sources: SearchResult[]): string {
  if (!sources.length) return question
  const blocks = sources.map((s, i) => {
    const where = [s.doc, s.section, s.page ? `第 ${s.page} 页` : '']
      .filter(Boolean)
      .join(' · ')
    return `[${i + 1}] ${where}\n${s.chunk}`
  })
  return [
    '请仅依据下面的知识库检索结果回答问题，并在依据处用 [序号] 标注来源。',
    '若检索结果不足以回答，请直接说明「根据知识库内容无法回答」，不要编造。',
    '',
    '【知识库检索结果】',
    blocks.join('\n\n'),
    '',
    '【问题】',
    question,
  ].join('\n')
}

export const useKbQaStore = defineStore('kbQa', () => {
  // ─── 面板布局 ──────────────────────────────────────────────────────────
  /** 面板宽度（px）；折叠时保留该值，再次展开可还原 */
  const panelWidth = ref(DEFAULT_KB_QA_WIDTH)
  const collapsed = ref(false)
  /** 是否全屏：占满主体宽度、隐藏知识库内容区（读长文档时用） */
  const fullscreen = ref(false)
  /** 主体容器实测宽度（由知识库页上报），用于把宽度收敛到合法区间 */
  const shellWidth = ref(0)

  // ─── 标签页 ────────────────────────────────────────────────────────────
  /** 当前激活的标签 key（'qa' 或某个文档标签） */
  const activeKey = ref(QA_TAB_KEY)
  /** 文档预览标签（不含常驻的「问答」） */
  const docTabs = ref<KbQaTab[]>([])

  // ─── 会话 ──────────────────────────────────────────────────────────────
  /** 问答针对的知识库（空串 = 尚未选择） */
  const kbId = ref('')
  /** 可选知识库（问答区的下拉数据源，与左栏的分页列表无关） */
  const kbOptions = ref<KB[]>([])
  const kbLoading = ref(false)
  /** 会话轮次（按时间正序） */
  const turns = ref<KbQaTurn[]>([])
  /** 检索 + 生成正在进行 */
  const streaming = ref(false)
  /** 选中的模型（null = 用平台默认模型） */
  const model = ref<string | null>(null)
  const modelId = ref<string | null>(null)
  const providerId = ref<string | null>(null)

  let controller: AbortController | null = null
  /**
   * 会话序号：检索是异步的，期间用户可能已经点了停止或换了知识库。
   * 每次 ask / stop / reset 都推进序号，检索回来后序号对不上就直接放弃这一轮，
   * 否则「停止」之后流水线还会自己把回答接着写出来。
   */
  let sessionSeq = 0

  // ─── 面板 ──────────────────────────────────────────────────────────────

  function setPanelWidth(width: number) {
    panelWidth.value = clampKbQaWidth(width, shellWidth.value)
  }

  /** 容器尺寸变化时同步，并把宽度收敛回合法区间 */
  function syncShellWidth(width: number) {
    shellWidth.value = width
    if (width > 0) setPanelWidth(panelWidth.value)
  }

  function toggleCollapsed() {
    collapsed.value = !collapsed.value
    // 收起时一并退出全屏，避免下次展开直接铺满整页（与对话页右栏同一处理）
    if (collapsed.value) fullscreen.value = false
  }

  /** 全屏 / 还原：全屏时问答区占满主体宽度，知识库内容区整体让位 */
  function toggleFullscreen() {
    fullscreen.value = !fullscreen.value
    if (fullscreen.value) collapsed.value = false
  }

  function resetPanelWidth() {
    setPanelWidth(DEFAULT_KB_QA_WIDTH)
  }

  // ─── 标签页 ────────────────────────────────────────────────────────────

  function activateTab(key: string) {
    activeKey.value = key
    // 从折叠态点标签是不可能的（那时没有标签栏），但展开动作本身不该被这件事绑住
  }

  /**
   * 打开（或聚焦）一个文档预览标签。
   *
   * 同一个文档只占一个标签：再次打开时复用已有标签并刷新快照，而不是堆出一排同名标签。
   */
  function openDocTab(kbIdValue: string, doc: KBDoc) {
    const key = `doc:${kbIdValue}:${doc.id}`
    const existing = docTabs.value.find((t) => t.key === key)
    if (existing) {
      existing.title = doc.name
      existing.doc = doc
    } else {
      docTabs.value = [...docTabs.value, { key, title: doc.name, kbId: kbIdValue, doc }]
    }
    activeKey.value = key
  }

  /** 关闭一个文档标签；关掉当前激活的那个时回落到「问答」 */
  function closeTab(key: string) {
    if (key === QA_TAB_KEY) return   // 首标签不可关
    docTabs.value = docTabs.value.filter((t) => t.key !== key)
    if (activeKey.value === key) activeKey.value = QA_TAB_KEY
  }

  /** 切换知识库时清掉上一个库的预览标签：它们指向的文档已经不在当前上下文里 */
  function closeDocTabs() {
    docTabs.value = []
    if (activeKey.value !== QA_TAB_KEY) activeKey.value = QA_TAB_KEY
  }

  /** 当前激活的文档标签（激活的是「问答」时为 null） */
  function currentDocTab(): KbQaTab | null {
    if (activeKey.value === QA_TAB_KEY) return null
    return docTabs.value.find((t) => t.key === activeKey.value) ?? null
  }

  // ─── 会话 ──────────────────────────────────────────────────────────────

  /**
   * 选择问答针对的知识库。
   *
   * **只换选择，不清会话**：左栏点开另一个库是很常见的浏览动作，顺手把正在进行的
   * 问答清掉太粗暴。每条回答都带着自己那一轮的来源，换库之后新的提问用新库，
   * 旧回答的依据仍然看得见；确实想重开时用「新会话」。
   */
  function setKb(id: string) {
    kbId.value = id
  }

  function setModel(name: string | null, pid: string | null, mid: string | null) {
    model.value = name
    providerId.value = pid
    modelId.value = mid
  }

  /** 选中的知识库配置里的 Top-K；拿不到就由后端按库配置兜底 */
  function topKFor(id: string): number | undefined {
    const kb = kbOptions.value.find((k) => k.id === id)
    return kb?.config?.topK
  }

  async function loadKbOptions() {
    if (kbLoading.value) return
    kbLoading.value = true
    try {
      // 问答区要能选到**任意**可见的库（含公共库与他人分享），所以走 all；
      // 100 是后端单页上限，够用且不必为此加分页
      const page = await fetchKBPage({ scope: 'all', page: 1, page_size: 100 })
      kbOptions.value = page.items
    } catch {
      kbOptions.value = []
    } finally {
      kbLoading.value = false
    }
  }

  function newTurn(partial: Partial<KbQaTurn> & Pick<KbQaTurn, 'role'>): KbQaTurn {
    return {
      id: nextId(),
      content: '',
      sources: [],
      noRelevant: false,
      retrieveError: '',
      pending: false,
      error: '',
      ...partial,
    }
  }

  /**
   * 提问：先用检索从知识库里取依据，再把「检索结果 + 问题」交给模型作答。
   *
   * 检索走 `/search`（与「检索」页签同一个接口，因此门槛、精排、去冗余、改写等
   * 库级配置都自动生效），生成走对话的 SSE 通道。**检索失败不阻断提问**：把
   * 失败原因留在回答上方，问题照常送给模型——否则一次检索故障会让整个问答不可用。
   */
  async function ask(question: string) {
    const text = question.trim()
    if (!text || streaming.value) return

    turns.value = [...turns.value, newTurn({ role: 'user', content: text })]
    const answer = newTurn({ role: 'assistant', pending: true })
    turns.value = [...turns.value, answer]

    streaming.value = true
    const target = turns.value[turns.value.length - 1]
    const session = ++sessionSeq

    let sources: SearchResult[] = []
    if (kbId.value) {
      try {
        const outcome = await searchKnowledgeBase(
          kbId.value, text, 'hybrid', topKFor(kbId.value) ?? 5,
        )
        sources = outcome.results
        target.sources = sources
        target.noRelevant = outcome.noRelevantResult
      } catch (err: unknown) {
        // 用后端给出的原因（如"查询向量化失败，请检查 Embedding 模型配置"），
        // 而不是 axios 的 "Request failed with status code 500"
        target.retrieveError = readApiError(err)
      }
    }
    // 检索期间被停止 / 被换库：这一轮作废，不要再发起生成
    if (session !== sessionSeq) {
      target.pending = false
      return
    }

    const selection = createEmptySelection()
    selection.model = model.value
    selection.modelId = modelId.value
    selection.providerId = providerId.value
    if (kbId.value) {
      // 把选中的库**交给后端**：它会注入「知识检索范围限定为 <库名>」并让 agent
      // 用自己的检索工具取内容。这是产品里"对知识库检索后作答"的正规通路，
      // 也决定了答案真正有依据。
      //
      // 实测教训：只把检索结果拼进提示词、不下发 kb_ids 时，agent 并不理会那段
      // 上下文，而是自己去列账号下的知识库并检索（回答会跑题到别的库）。
      //
      // 公共库 / 他人分享的库会被后端**静默忽略**（那里只认本人所有的库），
      // 此时下面的本地检索结果仍然照常展示，不至于什么都没发生。
      selection.kbIds = [kbId.value]
      selection.mode = 'knowledge'
    }

    controller = new AbortController()
    try {
      await sendStreamRequest(buildQaPrompt(text, sources), {
        callbacks: {
          onToken: (_agent, content) => { target.content += content },
          onReasoning: () => {},
          onAgentStart: () => {},
          onAgentEnd: () => {},
          onToolStart: () => {},
          onToolOutput: () => {},
          onToolEnd: () => {},
          onThreadId: () => {},
          onDone: () => {},
          // 主动停止会在 fetch 层变成一次 abort 错误，那不是"生成失败"
          onError: (message) => {
            if (!controller?.signal.aborted) target.error = message
          },
        },
        selection,
        signal: controller.signal,
      })
    } catch (err: unknown) {
      // 用户主动停止不是错误
      if (!controller?.signal.aborted) {
        target.error = err instanceof Error ? err.message : '生成失败'
      }
    } finally {
      target.pending = false
      // 只有仍是当前会话时才动全局开关：作废的那一轮不能把新会话的"生成中"关掉
      if (session === sessionSeq) {
        streaming.value = false
        controller = null
      }
    }
  }

  /** 停止生成（保留已经吐出的内容） */
  function stop() {
    sessionSeq += 1
    controller?.abort()
    controller = null
    streaming.value = false
    const last = turns.value[turns.value.length - 1]
    if (last?.role === 'assistant') last.pending = false
  }

  /** 清空会话（「新会话」，或用户在回答生成中重新发起） */
  function reset() {
    stop()
    turns.value = []
  }

  return {
    // 布局
    panelWidth,
    collapsed,
    fullscreen,
    shellWidth,
    setPanelWidth,
    syncShellWidth,
    toggleCollapsed,
    toggleFullscreen,
    resetPanelWidth,
    // 标签页
    activeKey,
    docTabs,
    activateTab,
    openDocTab,
    closeTab,
    closeDocTabs,
    currentDocTab,
    // 会话
    kbId,
    kbOptions,
    kbLoading,
    turns,
    streaming,
    model,
    modelId,
    providerId,
    setKb,
    setModel,
    loadKbOptions,
    ask,
    stop,
    reset,
  }
})
