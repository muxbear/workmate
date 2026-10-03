import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import type { KnowledgeSearchMode, KnowledgeSearchResult } from '../../knowledge/types'

/**
 * 会话侧知识库检索工具（Agentic RAG）。
 *
 * 两条通道都走同一个 `RetrievalService`（与页面检索/问答同源），因此同一问题
 * 在页面与会话里命中一致。
 *
 * 两条安全/上下文约束：
 * 1. **身份只来自运行时 configurable**（`config.configurable.user_id`），
 *    绝不接受模型传入的用户标识；取不到身份**失败关闭**（返回 error，不检索）；
 * 2. **retrieve-offload-delegate**（DeepAgents 官方 RAG 教程模式）：命中片段写到
 *    工作区 `retrieved/<批次>/chunk_N.md`，工具只回传路径与短摘要，
 *    让主智能体委派子智能体去读，主上下文不被大段原文挤占。
 */

/** 单个命中写盘后的路径长度上限（防超长路径） */
const MAX_PREVIEW_CHARS = 200
/** 单次检索最多回传的命中数上限 */
const MAX_TOP_K = 20

export interface KnowledgeToolDeps {
  /** 检索（注入收窄接口；生产为 RetrievalService） */
  retrievalProvider: () => {
    retrieve: (input: {
      userId: string
      kbId: string
      query: string
      topK?: number
      mode?: KnowledgeSearchMode
    }) => Promise<KnowledgeSearchResult>
  } | null
  /** 该用户可见的知识库清单（含计数，供模型挑库） */
  listBases: (userId: string) => Array<{
    id: string
    name: string
    docsCount: number
    chunksCount: number
  }>
}

export function buildKnowledgeTools(deps: KnowledgeToolDeps): DynamicStructuredTool[] {
  const listKnowledgeBases = new DynamicStructuredTool({
    name: 'list_knowledge_bases',
    description:
      '列出当前用户可用的本地知识库（含文档数与已索引切片数）。不知道用哪个库检索时先调用它。',
    schema: z.object({}),
    func: async (_input, _runManager, config) => {
      const userId = currentUserId(config)
      if (!userId) return JSON.stringify({ error: '缺少用户身份，无法列出知识库' })
      const bases = deps.listBases(userId)
      return JSON.stringify({
        total: bases.length,
        knowledge_bases: bases,
        hint: bases.length ? '用 kb_search 检索指定知识库' : '当前没有可用知识库'
      })
    }
  })

  const kbSearch = new DynamicStructuredTool({
    name: 'kb_search',
    description:
      '在本地知识库中检索内容。query 用关键词而非整句；不知道 kb_id 时先用 list_knowledge_bases。' +
      '返回命中片段的同时会把原文写到工作区 retrieved/ 目录，需要细读时读取这些文件。',
    schema: z.object({
      query: z.string().describe('检索查询（关键词，不要整句）'),
      kb_id: z.string().optional().describe('知识库 ID（优先使用）'),
      kb_name: z.string().optional().describe('知识库名称（按名称模糊匹配）'),
      mode: z.enum(['hybrid', 'vector', 'bm25']).optional().describe('检索模式，默认 hybrid'),
      top_k: z.number().int().min(1).max(MAX_TOP_K).optional().describe('返回条数，默认 5')
    }),
    func: async (input, _runManager, config) => {
      const userId = currentUserId(config)
      if (!userId) return JSON.stringify({ error: '缺少用户身份，无法检索知识库' })

      const retrieval = deps.retrievalProvider()
      if (!retrieval) return JSON.stringify({ error: '检索服务不可用' })

      const bases = deps.listBases(userId)
      const resolved = resolveKnowledgeBase(bases, input.kb_id, input.kb_name)
      if ('error' in resolved) {
        return JSON.stringify({ ...resolved, knowledge_bases: bases })
      }

      let search: KnowledgeSearchResult
      try {
        search = await retrieval.retrieve({
          userId,
          kbId: resolved.id,
          query: input.query,
          topK: input.top_k ?? 5,
          mode: input.mode
        })
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message })
      }

      const savedPaths = offloadHits(resolveWorkspaceDir(config), search)

      return JSON.stringify({
        total: search.hits.length,
        knowledge_base: { id: resolved.id, name: resolved.name },
        results: search.hits.map((hit, index) => ({
          doc: hit.docName,
          rel_path: hit.relPath,
          chunk_index: hit.chunkIndex,
          score: Number(hit.score.toFixed(4)),
          preview: hit.content.slice(0, MAX_PREVIEW_CHARS),
          saved_path: savedPaths[index]
        })),
        vectorSkipped: search.vectorSkipped,
        sparseSkipped: search.sparseSkipped,
        rerankSkipped: search.rerankSkipped,
        noRelevantResult: search.noRelevantResult,
        hint: search.noRelevantResult
          ? '知识库中没有找到相关内容：请如实告知用户，不要编造'
          : savedPaths.length
            ? '需要细读时读取 saved_path 指向的文件'
            : undefined
      })
    }
  })

  return [kbSearch, listKnowledgeBases]
}

/** 身份只认运行时注入的 user_id；缺失即失败关闭 */
function currentUserId(config?: RunnableConfig): string {
  const raw = config as
    | { configurable?: { user_id?: unknown }; config?: { configurable?: { user_id?: unknown } } }
    | undefined
  const value = raw?.configurable?.user_id ?? raw?.config?.configurable?.user_id
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** 工作区目录（与 DesktopToolRegistry 同一来源：configurable.workspace_dir） */
function resolveWorkspaceDir(config?: RunnableConfig): string | null {
  const raw = config as
    | {
        configurable?: { workspace_dir?: unknown }
        config?: { configurable?: { workspace_dir?: unknown } }
      }
    | undefined
  const value = raw?.configurable?.workspace_dir ?? raw?.config?.configurable?.workspace_dir
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * 写盘：`<workspace>/retrieved/<批次>/chunk_N.md`，带 `# Source:` 头部。
 * 无工作区或写盘失败时跳过（返回空数组，不影响检索结果本身）。
 */
function offloadHits(
  workspaceDir: string | null,
  search: KnowledgeSearchResult
): Array<string | undefined> {
  if (!workspaceDir || !search.hits.length) return []
  const batchId = randomUUID().slice(0, 8)
  const batchDir = resolve(join(workspaceDir, 'retrieved', batchId))
  const workspaceRoot = resolve(workspaceDir)
  // 防御：批次目录必须落在工作区内
  if (!batchDir.startsWith(workspaceRoot)) return []
  try {
    mkdirSync(batchDir, { recursive: true })
    return search.hits.map((hit, index) => {
      const file = join(batchDir, `chunk_${index + 1}.md`)
      const heading = hit.heading ? ` › ${hit.heading}` : ''
      writeFileSync(
        file,
        [
          `# Source: ${hit.docName} › ${hit.relPath} › 切片 #${hit.chunkIndex + 1}${heading}`,
          `# Score: ${hit.score.toFixed(4)}`,
          '',
          hit.content
        ].join('\n'),
        'utf-8'
      )
      return file
    })
  } catch (err) {
    console.warn('[knowledge-tool] 命中片段写盘失败（不影响检索结果）：', err)
    return []
  }
}

/** 解析知识库：id 优先 → 名称模糊匹配 → 都不给时用第一个库 */
function resolveKnowledgeBase(
  bases: Array<{ id: string; name: string }>,
  kbId?: string,
  kbName?: string
): { id: string; name: string } | { error: string; candidates?: unknown } {
  if (!bases.length) return { error: '当前用户没有可用知识库' }
  if (kbId) {
    const found = bases.find((base) => base.id === kbId)
    return found ?? { error: `未找到知识库：${kbId}` }
  }
  if (kbName) {
    const keyword = kbName.trim().toLowerCase()
    const matches = bases.filter((base) => base.name.toLowerCase().includes(keyword))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      return { error: `知识库名称「${kbName}」不唯一，请用 kb_id 指定`, candidates: matches }
    }
    return { error: `未找到知识库：${kbName}` }
  }
  return bases[0]
}
