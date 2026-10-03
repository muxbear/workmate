import type { KnowledgeStore } from './KnowledgeStore'

/**
 * 稀疏（关键词）检索：Intl.Segmenter 中文分词 + SQLite FTS5 原生 BM25。
 *
 * - FTS5 的 `bm25(fts, k1, b)` 是**真 BM25**，设置页的 bm25K1 / bm25B 参数真实生效
 *   （web 后端的客户端词频统计做不到这一点）；
 * - 写入前把原文分词成空格串存进 `kb_chunk_fts.text_tokens`，查询串用同一分词器，
 *   保证「建索引」与「检索」两侧口径一致；
 * - 用户输入绝不直接拼进 MATCH：先分词、再按 token 加双引号转义（防注入与语法错误，
 *   未转义时 FTS5 会直接抛 `fts5: syntax error`）。
 */

/** 分词器：中文按词切（Electron 内置 ICU，零依赖），拉丁按词切并小写化 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 单条查询最多保留的 token 数（防止超长查询把 MATCH 撑爆） */
const MAX_QUERY_TOKENS = 32
/** LIKE 兜底候选上限 */
const LIKE_FALLBACK_LIMIT = 50

export class SparseIndexer {
  private readonly store: KnowledgeStore

  constructor(store: KnowledgeStore) {
    this.store = store
  }

  /** 原文 → 空格分隔的分词串（写入 FTS 的列值） */
  tokenize(text: string): string {
    return segment(text).join(' ')
  }

  /** 查询串 → MATCH 表达式（引号转义 + OR 连接）；无有效 token 返回 null */
  buildMatch(query: string): string | null {
    const tokens = segment(query).slice(0, MAX_QUERY_TOKENS)
    if (!tokens.length) return null
    return tokens.map(quoteFtsToken).join(' OR ')
  }

  /** 按查询串取检索用的 token 列表（LIKE 兜底与「是否短查询」的判断依据） */
  tokensOf(query: string): string[] {
    return segment(query).slice(0, MAX_QUERY_TOKENS)
  }

  /**
   * 稀疏检索。分词后 token 少于 2 个时追加一次 `content LIKE` 兜底
   * （短查询/新词在 FTS 里召回不足）。
   *
   * 结果还要过一道**token 覆盖率过滤**：MATCH 用 OR 语义（保召回），
   * 只命中一个常见字（如「的」）的文档 BM25 也可能排上来，这类噪声在
   * 「库里只有一篇文档」时尤其明显。要求命中至少 `min(2, token 数)` 个
   * 不同查询词，既压住噪声又不误伤短查询。
   */
  search(input: {
    kbId: string
    userId: string
    query: string
    limit: number
    k1: number
    b: number
  }): Array<{ chunkId: number; score: number }> {
    const tokens = this.tokensOf(input.query)
    if (!tokens.length) return []

    const scores = new Map<number, number>()
    const match = this.buildMatch(input.query)
    if (match) {
      for (const row of this.store.searchSparse({
        kbId: input.kbId,
        userId: input.userId,
        match,
        limit: input.limit,
        k1: input.k1,
        b: input.b
      })) {
        scores.set(row.chunkId, row.score)
      }
    }

    if (tokens.length < 2) {
      const keyword = input.query.trim().slice(0, 100)
      if (keyword) {
        for (const row of this.store.searchLike({
          kbId: input.kbId,
          userId: input.userId,
          keyword,
          limit: LIKE_FALLBACK_LIMIT
        })) {
          if (!scores.has(row.chunkId)) scores.set(row.chunkId, row.score)
        }
      }
    }

    const required = Math.min(2, tokens.length)
    const ranked = [...scores.entries()]
      .map(([chunkId, score]) => ({ chunkId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
    if (required <= 1) return ranked

    const covered = new Set(
      this.store
        .getChunksByIds(ranked.map((item) => item.chunkId))
        .filter((chunk) => coverageOf(chunk.content, tokens) >= required)
        .map((chunk) => chunk.chunkId)
    )
    return ranked.filter((item) => covered.has(item.chunkId))
  }
}

/** 分词 token 在正文中的覆盖个数（CJK 直接子串匹配；拉丁不区分大小写） */
function coverageOf(content: string, tokens: string[]): number {
  const lower = content.toLowerCase()
  let count = 0
  for (const token of tokens) {
    if (lower.includes(token)) count += 1
  }
  return count
}

/** 分词：只保留词形 token（过滤空白与标点），拉丁统一小写 */
function segment(text: string): string[] {
  const result: string[] = []
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue
    const token = part.segment.trim().toLowerCase()
    if (token) result.push(token)
  }
  return result
}

/**
 * 单个 token → FTS5 短语字面量。
 *
 * 分词本身已挡掉标点（`(`、`*`、`"` 等都不会成为 token），这里是第二道防线：
 * 万一将来换分词器产出带引号的 token，也不会破坏 MATCH 语法。
 */
export function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}
