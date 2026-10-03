import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildKnowledgeTools, type KnowledgeToolDeps } from '../../../src/main/agent/tools/KnowledgeTool'
import type { KnowledgeSearchResult } from '../../../src/main/knowledge/types'

/**
 * 会话侧知识库工具（kb_search / list_knowledge_bases）单元测试。
 * 纯逻辑 + 临时目录写盘，不需要 better-sqlite3（无需切 ABI）。
 */

const BASES = [
  { id: 'kb-1', name: '产品资料库', docsCount: 12, chunksCount: 340 },
  { id: 'kb-2', name: '产品资料库（归档）', docsCount: 3, chunksCount: 40 },
  { id: 'kb-3', name: '研发规范', docsCount: 5, chunksCount: 88 }
]

function searchResult(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    hits: [
      {
        chunkUid: 'uid-1',
        chunkId: 1,
        docId: 'doc-1',
        docName: '需求说明.md',
        relPath: '文档/需求说明.md',
        chunkIndex: 2,
        heading: '背景',
        content: '离线部署采用离线安装包，向量检索使用 sqlite-vec 扩展。',
        score: 0.8123,
        charStart: 0,
        charEnd: 30,
        vecScore: 0.91
      }
    ],
    vectorSkipped: false,
    sparseSkipped: false,
    rerankSkipped: true,
    noRelevantResult: false,
    ...overrides
  }
}

function makeDeps(result: KnowledgeSearchResult = searchResult()): {
  deps: KnowledgeToolDeps
  retrieve: ReturnType<typeof vi.fn>
} {
  const retrieve = vi.fn(async () => result)
  return {
    retrieve,
    deps: {
      retrievalProvider: () => ({ retrieve }),
      listBases: () => BASES
    }
  }
}

function tools(deps: KnowledgeToolDeps): {
  kbSearch: ReturnType<typeof buildKnowledgeTools>[0]
  listBases: ReturnType<typeof buildKnowledgeTools>[1]
} {
  const [kbSearch, listBases] = buildKnowledgeTools(deps)
  return { kbSearch, listBases }
}

const USER = { configurable: { user_id: 'u1' } }

describe('list_knowledge_bases', () => {
  it('返回用户可用知识库与计数', async () => {
    const { deps } = makeDeps()
    const { listBases } = tools(deps)
    const output = JSON.parse(await listBases.invoke({}, USER)) as {
      total: number
      knowledge_bases: unknown[]
      hint: string
    }
    expect(output.total).toBe(3)
    expect(output.knowledge_bases).toHaveLength(3)
    expect(output.hint).toContain('kb_search')
  })

  it('缺少用户身份：失败关闭（不返回知识库）', async () => {
    const { deps } = makeDeps()
    const { listBases } = tools(deps)
    const output = JSON.parse(await listBases.invoke({}, { configurable: {} })) as { error: string }
    expect(output.error).toContain('缺少用户身份')
  })
})

describe('kb_search', () => {
  it('按 kb_id 检索并返回命中摘要（含 saved_path 与降级标记）', async () => {
    const { deps, retrieve } = makeDeps()
    const { kbSearch } = tools(deps)
    const workspace = mkdtempSync(join(tmpdir(), 'ke-kb-tool-'))
    try {
      const output = JSON.parse(
        await kbSearch.invoke(
          { query: '离线部署', kb_id: 'kb-1', top_k: 3 },
          { configurable: { user_id: 'u1', workspace_dir: workspace } }
        )
      ) as {
        total: number
        knowledge_base: { id: string; name: string }
        results: Array<{ doc: string; rel_path: string; saved_path?: string; preview: string }>
        rerankSkipped: boolean
      }

      expect(retrieve).toHaveBeenCalledWith({
        userId: 'u1',
        kbId: 'kb-1',
        query: '离线部署',
        topK: 3,
        mode: undefined
      })
      expect(output.total).toBe(1)
      expect(output.knowledge_base).toEqual({ id: 'kb-1', name: '产品资料库' })
      expect(output.results[0].rel_path).toBe('文档/需求说明.md')
      expect(output.results[0].preview.length).toBeLessThanOrEqual(200)
      expect(output.rerankSkipped).toBe(true)

      // retrieve-offload-delegate：命中片段已落盘，带 Source 头
      const savedPath = output.results[0].saved_path as string
      expect(savedPath).toBeTruthy()
      expect(savedPath.startsWith(join(workspace, 'retrieved'))).toBe(true)
      expect(existsSync(savedPath)).toBe(true)
      const content = readFileSync(savedPath, 'utf-8')
      expect(content).toContain('# Source: 需求说明.md › 文档/需求说明.md › 切片 #3')
      expect(content).toContain('sqlite-vec')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('无工作区时跳过写盘：结果仍返回，只是没有 saved_path', async () => {
    const { deps } = makeDeps()
    const { kbSearch } = tools(deps)
    const output = JSON.parse(
      await kbSearch.invoke({ query: '部署', kb_id: 'kb-1' }, USER)
    ) as { results: Array<{ saved_path?: string }>; hint?: string }
    expect(output.results[0].saved_path).toBeUndefined()
    expect(output.hint).toBeUndefined()
  })

  it('缺少用户身份：失败关闭（不触发检索）', async () => {
    const { deps, retrieve } = makeDeps()
    const { kbSearch } = tools(deps)
    const output = JSON.parse(
      await kbSearch.invoke({ query: 'x' }, { configurable: {} })
    ) as { error: string }
    expect(output.error).toContain('缺少用户身份')
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('按名称模糊匹配；名称不唯一时返回候选而不是瞎选', async () => {
    const { deps, retrieve } = makeDeps()
    const { kbSearch } = tools(deps)

    const unique = JSON.parse(
      await kbSearch.invoke({ query: '规范', kb_name: '研发' }, USER)
    ) as { knowledge_base: { id: string } }
    expect(unique.knowledge_base.id).toBe('kb-3')

    const ambiguous = JSON.parse(
      await kbSearch.invoke({ query: '部署', kb_name: '产品资料库' }, USER)
    ) as { error: string; candidates: unknown[] }
    expect(ambiguous.error).toContain('不唯一')
    expect(ambiguous.candidates).toHaveLength(2)
    // 歧义时不应发起检索
    expect(retrieve).toHaveBeenCalledTimes(1)

    const missing = JSON.parse(
      await kbSearch.invoke({ query: 'x', kb_name: '不存在' }, USER)
    ) as { error: string }
    expect(missing.error).toContain('未找到')
  })

  it('未指定库时用第一个库；没有库时明确报错', async () => {
    const { deps } = makeDeps()
    const { kbSearch } = tools(deps)
    const output = JSON.parse(await kbSearch.invoke({ query: 'x' }, USER)) as {
      knowledge_base: { id: string }
    }
    expect(output.knowledge_base.id).toBe('kb-1')

    const empty = tools({ retrievalProvider: () => ({ retrieve: vi.fn() }), listBases: () => [] })
    const none = JSON.parse(
      await empty.kbSearch.invoke({ query: 'x' }, USER)
    ) as { error: string }
    expect(none.error).toContain('没有可用知识库')
  })

  it('检索抛错：把原因回传（指引去设置页），不抛出给模型', async () => {
    const deps: KnowledgeToolDeps = {
      retrievalProvider: () => ({
        retrieve: async () => {
          throw new Error('稀疏检索已关闭且向量检索不可用')
        }
      }),
      listBases: () => BASES
    }
    const { kbSearch } = tools(deps)
    const output = JSON.parse(
      await kbSearch.invoke({ query: 'x', kb_id: 'kb-1' }, USER)
    ) as { error: string }
    expect(output.error).toContain('稀疏检索已关闭')
  })

  it('无相关内容：hint 明确要求如实告知、不要编造', async () => {
    const { deps } = makeDeps(searchResult({ hits: [], noRelevantResult: true }))
    const { kbSearch } = tools(deps)
    const output = JSON.parse(
      await kbSearch.invoke({ query: '股票行情', kb_id: 'kb-1' }, USER)
    ) as { total: number; noRelevantResult: boolean; hint: string }
    expect(output.total).toBe(0)
    expect(output.noRelevantResult).toBe(true)
    expect(output.hint).toContain('不要编造')
  })
})
