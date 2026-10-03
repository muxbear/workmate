import type { KnowledgeEngineConfig } from './knowledge-config'
import type { RetrievalHistoryTurn } from './types'

/**
 * 查询改写（Hybrid RAG 的 query enhancement）。
 *
 * 一次 LLM 调用把用户问题改写成 1~2 条**不同措辞**的检索查询（保留专有名词与数字），
 * 与原始问题一起多路召回、再按排名融合（RRF）。原文永远排在第一位：
 * 改写只做**召回扩展**，不做替换——改写跑偏时原文仍然保底。
 *
 * 多轮（P7）：问答面板会把最近几轮对话带进来，让「它的缺点呢」这类省略主语的追问
 * 先补全指代再改写；上下文只进改写提示词，检索仍以本轮问题为准。
 *
 * 与 web 后端同口径：默认关闭（`queryRewriteEnabled=false`）、模型复用图谱写模型
 * （未配置时回退默认模型）、任何失败退化为只用原问题（不阻断检索）。
 */

/** 单个变体的长度上限（防止模型输出整段话） */
const MAX_QUERY_CHARS = 100
/** 最多采纳的变体数（不含原问题） */
const MAX_VARIANTS = 2
/** 改写提示词里最多带几轮对话（一轮 = user + assistant 两条） */
const MAX_REWRITE_HISTORY_TURNS = 2
/** 历史单条内容截断长度（防止把上一轮整段回答灌进提示词） */
const MAX_REWRITE_HISTORY_CHARS = 400

export const QUERY_REWRITE_PROMPT = [
  '你是检索查询改写助手。把用户的问题改写成 1~2 条**不同措辞**的检索查询，用于关键词与语义检索。',
  '要求：',
  '1. 保留问题里的专有名词、英文术语与数字，不要翻译、不要扩写背景；',
  '2. 每条查询控制在 30 字以内，用词尽量贴近原文可能的写法（补充同义说法）；',
  '3. 不要回答问题，不要解释，不要编号或加引号；',
  '4. 若提供了对话上下文且当前问题是省略主语的追问（如「它的缺点呢」），先结合上下文补全指代再改写；',
  '5. 不要照抄上下文里的原句，只输出改写后的检索查询。',
  '每行输出一条查询，最多两行。'
].join('\n')

/** 组装改写请求的 user 文本：有历史时带「最近对话」段（仅供补全指代，不照抄） */
export function buildRewriteUser(question: string, history?: RetrievalHistoryTurn[]): string {
  const turns = (history ?? [])
    .filter((turn) => String(turn?.content ?? '').trim())
    .slice(-MAX_REWRITE_HISTORY_TURNS * 2)
  if (!turns.length) return question
  const lines = turns.map((turn) => {
    const text = String(turn.content).trim()
    const clipped = text.length > MAX_REWRITE_HISTORY_CHARS
      ? `${text.slice(0, MAX_REWRITE_HISTORY_CHARS)}…`
      : text
    return `${turn.role === 'user' ? '用户' : '助手'}：${clipped}`
  })
  return `最近对话：\n${lines.join('\n')}\n\n当前问题：${question}`
}

/** 解析模型输出：逐行清洗、去重、限长，剔除与原问题重复的变体 */
export function parseRewriteResponse(text: string, original: string): string[] {
  const normalizedOriginal = normalize(original)
  const out: string[] = []
  const seen = new Set<string>([normalizedOriginal])
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine
      .replace(/^[\s\-•*·\d.、)）]+/, '') // 去列表符号/编号
      .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
      .trim()
    if (!line || line.length > MAX_QUERY_CHARS) continue
    const key = normalize(line)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= MAX_VARIANTS) break
  }
  return out
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '')
}

/** 文本补全模型（与 GraphChatModel 的 complete 同形；注入便于单测） */
export interface RewriteChatModel {
  complete: (input: { system: string; user: string }) => Promise<string>
}

export interface QueryRewriterDeps {
  /**
   * 解析改写模型（内部带回退链；解析失败返回 null → 降级为只用原查询）。
   * 传入生效配置是为了让适配器按 `graphModel` 选模型（与 web 复用 entity_model 同口径）。
   */
  resolveModel: (config: KnowledgeEngineConfig) => Promise<RewriteChatModel | null>
}

/** 检索侧注入的收窄接口（与 RetrievalService 的 QueryRewriter 契约一致） */
export interface QueryRewriterContract {
  available: (config: KnowledgeEngineConfig) => boolean
  rewrite: (
    query: string,
    config: KnowledgeEngineConfig,
    options?: { history?: RetrievalHistoryTurn[] }
  ) => Promise<string[]>
}

export class QueryRewriter implements QueryRewriterContract {
  private readonly deps: QueryRewriterDeps

  constructor(deps: QueryRewriterDeps) {
    this.deps = deps
  }

  /** 开关打开才可用（模型解析失败会在 rewrite 内降级，不在这里判断） */
  available(config: KnowledgeEngineConfig): boolean {
    return config.queryRewriteEnabled
  }

  /** 返回变体列表（不含原问题）；任何失败都返回空数组（调用方只用原问题） */
  async rewrite(
    query: string,
    config: KnowledgeEngineConfig,
    options?: { history?: RetrievalHistoryTurn[] }
  ): Promise<string[]> {
    const question = String(query ?? '').trim()
    if (!question) return []
    try {
      const model = await this.deps.resolveModel(config)
      if (!model) return []
      const text = await model.complete({
        system: QUERY_REWRITE_PROMPT,
        user: buildRewriteUser(question, options?.history)
      })
      return parseRewriteResponse(text, question)
    } catch (err) {
      console.warn('[knowledge-rewrite] 查询改写失败，本次只用原问题：', err)
      return []
    }
  }
}
