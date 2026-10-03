import type { ContextMode } from './types'

/**
 * 自动化任务的「上下文模式」提示词。
 *
 * 与 web 后端的口径一致（`web/backend/src/api/automation/runner.py` 的 `_MODE_LABELS`：
 * default=默认 / files=引用上传文件 / knowledge=引用知识库）：把任务模式与可检索的知识库
 * **追加到本次任务的用户消息里**，让无窗口运行的后台智能体知道该不该去检索、能检索哪些库。
 *
 * 边界：这里只负责「告诉模型有什么可用」；真正的检索由主智能体的 `kb_search` 工具完成
 * （工具在 AgentManager 侧注册，身份取自运行时 configurable）。
 */

export interface KnowledgeHintBase {
  id: string
  name: string
  docsCount: number
}

/** 单条模式标签（与 web 对齐；desktop 的 local 对应 web 的 files） */
const MODE_LABELS: Record<ContextMode, string> = {
  default: '默认',
  local: '本地文件',
  knowledge: '知识库'
}

/**
 * 组装上下文提示。返回空串表示无需追加（默认模式）。
 *
 * - `knowledge`：列出该用户可检索的本地知识库；没有可用库时明确说明，避免模型编造资料；
 * - `local`：只声明模式（文件已在消息里或工作区中，读取方式不变）；
 * - `default`：不追加。
 */
export function buildContextHint(input: {
  contextMode: ContextMode
  knowledgeBases: KnowledgeHintBase[]
}): string {
  const mode = input.contextMode
  if (mode === 'default') return ''

  const lines = [`【模式】当前任务模式：${MODE_LABELS[mode]}。`]
  if (mode === 'knowledge') {
    if (input.knowledgeBases.length) {
      const list = input.knowledgeBases
        .map((base) => `${base.name}（${base.docsCount} 篇）`)
        .join('、')
      lines.push(
        `【知识库】可检索的本地知识库：${list}。需要资料依据时先调用 list_knowledge_bases 确认可用库，再用 kb_search 检索（query 用关键词）；`,
        '结论请标注来源文档名；检索为空时如实说明「知识库中没有相关内容」，不要编造。'
      )
    } else {
      lines.push(
        '【知识库】当前用户没有可检索的本地知识库（尚未创建、或尚未建立索引）。',
        '请如实告知用户这一点，不要凭常识编造资料内容。'
      )
    }
  }
  return lines.join('\n')
}
