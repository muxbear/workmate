import type { KnowledgeEngineConfig } from './knowledge-config'

/**
 * 查询改写（Hybrid RAG 的 query enhancement）。
 *
 * 一次 LLM 调用把用户问题改写成 1~2 条**不同措辞**的检索查询（保留专有名词与数字），
 * 与原始问题一起多路召回、再按排名融合（RRF）。原文永远排在第一位：
 * 改写只做**召回扩展**，不做替换——改写跑偏时原文仍然保底。
 *
 * 与 web 后端同口径：默认关闭（`queryRewriteEnabled=false`）、模型复用图谱写模型
 * （未配置时回退默认模型）、任何失败退化为只用原问题（不阻断检索）。
 */

/** 单个变体的长度上限（防止模型输出整段话） */
const MAX_QUERY_CHARS = 100
/** 最多采纳的变体数（不含原问题） */
const MAX_VARIANTS = 2

export const QUERY_REWRITE_PROMPT = [
  '你是检索查询改写助手。把用户的问题改写成 1~2 条**不同措辞**的检索查询，用于关键词与语义检索。',
  '要求：',
  '1. 保留问题里的专有名词、英文术语与数字，不要翻译、不要扩写背景；',
  '2. 每条查询控制在 30 字以内，用词尽量贴近原文可能的写法（补充同义说法）；',
  '3. 不要回答问题，不要解释，不要编号或加引号。',
  '每行输出一条查询，最多两行。'
].join('\n')

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
  rewrite: (query: string, config: KnowledgeEngineConfig) => Promise<string[]>
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
  async rewrite(query: string, config: KnowledgeEngineConfig): Promise<string[]> {
    const question = String(query ?? '').trim()
    if (!question) return []
    try {
      const model = await this.deps.resolveModel(config)
      if (!model) return []
      const text = await model.complete({ system: QUERY_REWRITE_PROMPT, user: question })
      return parseRewriteResponse(text, question)
    } catch (err) {
      console.warn('[knowledge-rewrite] 查询改写失败，本次只用原问题：', err)
      return []
    }
  }
}
