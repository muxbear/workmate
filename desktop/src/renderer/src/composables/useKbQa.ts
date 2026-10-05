import { computed, onMounted, ref, type Ref } from 'vue'
import { useKnowledgeStore } from '@store/knowledge'
import { useModelStore } from '@store/models'
import type { KnowledgeQaCitation } from '../../../shared/contracts'

/**
 * 知识库问答（R6：自 KnowledgePage 外提）。
 *
 * 2-Step RAG 提问与流式回答由 store 订阅的 ask-* 事件驱动；本组合件只承载
 * 提问输入、模型选择（models.json 的 id，空 = 默认模型）与引用点击跳转。
 * 引用文件是否在当前库内由页面判定（`openByRelPath` 返回 false 时提示已失效）。
 */

export interface KbQaDeps {
  /** 当前选中知识库 id（'' = 未选择） */
  selectedKbId: Ref<string>
  /** 轻提示（toast） */
  notify: (text: string) => void
  /** 按库内相对路径打开文件标签页；返回 false 表示不在当前库中 */
  openByRelPath: (relPath: string) => boolean
}

export function useKbQa(deps: KbQaDeps) {
  const kbStore = useKnowledgeStore()

  const question = ref('')
  const askState = computed(() => kbStore.askState)

  const ask = async (): Promise<void> => {
    const text = question.value.trim()
    if (!text || !deps.selectedKbId.value) return
    question.value = ''
    const started = await kbStore.askQuestion(
      deps.selectedKbId.value,
      text,
      qaModelName.value || undefined
    )
    if (!started) deps.notify(kbStore.askState?.error || '提问失败')
  }

  const cancelAsk = (): void => {
    void kbStore.cancelAsk()
  }

  /** 引用点击：在右侧以标签页打开对应文件（与文件树点击同一条路径） */
  const openCitation = (citation: KnowledgeQaCitation): void => {
    if (!deps.openByRelPath(citation.relPath)) deps.notify('引用文件已不在当前库中')
  }

  /** 问答模型（models.json 的 id；空 = 用默认模型） */
  const qaModelName = ref('')
  const qaModelMenuOpen = ref(false)
  const qaModelStore = useModelStore()
  onMounted(() => {
    void qaModelStore.load()
  })
  const qaModelLabel = computed(
    () => qaModelStore.models.find((item) => item.id === qaModelName.value)?.name ?? '默认模型'
  )
  function pickQaModel(id: string): void {
    qaModelName.value = id
    qaModelMenuOpen.value = false
  }

  return {
    question,
    askState,
    ask,
    cancelAsk,
    openCitation,
    qaModelName,
    qaModelMenuOpen,
    qaModelStore,
    qaModelLabel,
    pickQaModel
  }
}
