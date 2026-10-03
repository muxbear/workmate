import { describe, expect, it, vi } from 'vitest'
import {
  CommunityService,
  CommunitySummaryError,
  detectCommunities,
  renderCommunityContext,
  type EntityGraph
} from '../../../src/main/knowledge/CommunityService'
import type { GraphChatModel } from '../../../src/main/knowledge/GraphService'
import type { KnowledgeStore } from '../../../src/main/knowledge/KnowledgeStore'
import type { KnowledgeEngineConfig } from '../../../src/main/knowledge/knowledge-config'

/**
 * 社区摘要（GraphRAG 全局检索侧）单元测试：
 * Louvain 聚类、社区上下文渲染、失败可见（个别社区失败仍入库 + 抛错）。
 */

function graphOf(input: {
  entities: Array<{ key: string; name?: string; sourceText?: string | null }>
  relations: Array<{ from: string; to: string; label: string }>
}): EntityGraph {
  const entityIndex = new Map<string, { name: string; type: string; sourceText: string | null }>()
  for (const entity of input.entities) {
    entityIndex.set(entity.key, {
      name: entity.name ?? entity.key,
      type: '概念',
      sourceText: entity.sourceText ?? null
    })
  }
  return {
    entityIndex,
    entities: input.entities.map((entity) => ({ key: entity.key })),
    relations: input.relations
  }
}

/** store 替身：只记录社区写入 */
function storeFake(graph: EntityGraph): {
  store: KnowledgeStore
  written: Array<Array<{ entityKeys: string[]; summary: string }>>
} {
  const written: Array<Array<{ entityKeys: string[]; summary: string }>> = []
  const store = {
    loadKbGraph: () => graph,
    replaceCommunities: (input: { communities: Array<{ entityKeys: string[]; summary: string }> }) => {
      written.push(input.communities)
      return input.communities.length
    }
  } as unknown as KnowledgeStore
  return { store, written }
}

const config = { graphModel: 'stub' } as KnowledgeEngineConfig

describe('detectCommunities（Louvain）', () => {
  it('两簇明显分离的实体图分成两个社区，按规模排序', () => {
    const graph = graphOf({
      entities: [
        { key: 'a' },
        { key: 'b' },
        { key: 'c' },
        { key: 'x' },
        { key: 'y' }
      ],
      relations: [
        { from: 'a', to: 'b', label: 'r' },
        { from: 'b', to: 'c', label: 'r' },
        { from: 'a', to: 'c', label: 'r' },
        { from: 'x', to: 'y', label: 'r' }
      ]
    })
    const clusters = detectCommunities(graph)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].keys.sort()).toEqual(['a', 'b', 'c'])
    expect(clusters[1].keys.sort()).toEqual(['x', 'y'])
  })

  it('孤点与单实体社区被过滤（规模 < 2 不成社区）', () => {
    const graph = graphOf({
      entities: [{ key: 'lonely' }, { key: 'a' }, { key: 'b' }],
      relations: [{ from: 'a', to: 'b', label: 'r' }]
    })
    const clusters = detectCommunities(graph)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].keys.sort()).toEqual(['a', 'b'])
  })

  it('悬挂边（指向库外实体）不进图；完全没有边时返回空', () => {
    const graph = graphOf({
      entities: [{ key: 'a' }, { key: 'b' }],
      relations: [{ from: 'a', to: 'ghost', label: 'r' }]
    })
    expect(detectCommunities(graph)).toEqual([])
  })

  it('平行边累加权重不影响社区划分的稳定性', () => {
    const graph = graphOf({
      entities: [{ key: 'a' }, { key: 'b' }, { key: 'x' }, { key: 'y' }],
      relations: [
        { from: 'a', to: 'b', label: 'r1' },
        { from: 'a', to: 'b', label: 'r2' },
        { from: 'x', to: 'y', label: 'r1' }
      ]
    })
    const clusters = detectCommunities(graph)
    expect(clusters).toHaveLength(2)
  })
})

describe('renderCommunityContext', () => {
  it('渲染数据边界与主题编号；空社区返回空串（保持「未找到」原行为）', () => {
    expect(renderCommunityContext([])).toBe('')
    expect(renderCommunityContext([{ entityKeys: [], summary: '   ' }])).toBe('')
    const text = renderCommunityContext([
      { entityKeys: ['a'], summary: '这是一组关于向量检索的主题。' },
      { entityKeys: ['b'], summary: '这组讲的是部署与信创适配。' }
    ])
    expect(text).toContain('<<<知识库全局主题 开始>>>')
    expect(text).toContain('[T1] 这是一组关于向量检索的主题。')
    expect(text).toContain('[T2] 这组讲的是部署与信创适配。')
  })
})

describe('CommunityService.buildCommunities', () => {
  const graph = graphOf({
    entities: [
      { key: 'a', name: '向量检索', sourceText: '向量检索使用余弦相似度' },
      { key: 'b', name: 'BM25', sourceText: 'BM25 负责关键词召回' },
      { key: 'x', name: '离线部署', sourceText: '离线安装包部署' },
      { key: 'y', name: '银河麒麟', sourceText: '适配银河麒麟' }
    ],
    relations: [
      { from: 'a', to: 'b', label: '配合' },
      { from: 'x', to: 'y', label: '适配' }
    ]
  })

  function makeService(model: GraphChatModel, storeSource = graph): {
    service: CommunityService
    written: Array<Array<{ entityKeys: string[]; summary: string }>>
  } {
    const fake = storeFake(storeSource)
    return {
      service: new CommunityService({ store: fake.store, resolveModel: async () => model }),
      written: fake.written
    }
  }

  it('逐社区生成摘要并落库（提示词带上实体、关系与片段）', async () => {
    const prompts: string[] = []
    const model: GraphChatModel = {
      extract: vi.fn(),
      complete: async ({ user }) => {
        prompts.push(user)
        return `摘要：${user.slice(0, 10)}`
      }
    }
    const { service, written } = makeService(model)
    const result = await service.buildCommunities({ userId: 'u1', kbId: 'kb', config })

    expect(result.communities).toBe(2)
    expect(written[0]).toHaveLength(2)
    expect(written[0][0].summary.startsWith('摘要：')).toBe(true)
    // 提示词含实体名与关系
    expect(prompts.join('\n')).toContain('向量检索')
    expect(prompts.join('\n')).toContain('配合')
  })

  it('个别社区失败：已成功的入库存下来，并抛 CommunitySummaryError（不静默）', async () => {
    let calls = 0
    const model: GraphChatModel = {
      extract: vi.fn(),
      complete: async () => {
        calls += 1
        if (calls === 2) throw new Error('模型超时')
        return '第一条摘要'
      }
    }
    const { service, written } = makeService(model)
    await expect(
      service.buildCommunities({ userId: 'u1', kbId: 'kb', config })
    ).rejects.toBeInstanceOf(CommunitySummaryError)
    expect(written[0]).toHaveLength(1)
  })

  it('模型没有文本补全能力：抛出明确错误', async () => {
    const model: GraphChatModel = { extract: vi.fn() }
    const { service } = makeService(model)
    await expect(
      service.buildCommunities({ userId: 'u1', kbId: 'kb', config })
    ).rejects.toBeInstanceOf(CommunitySummaryError)
  })

  it('实体图不足（无社区）：清空社区并返回 0', async () => {
    const model: GraphChatModel = { extract: vi.fn(), complete: async () => 'x' }
    const { service, written } = makeService(model, graphOf({ entities: [{ key: 'a' }], relations: [] }))
    const result = await service.buildCommunities({ userId: 'u1', kbId: 'kb', config })
    expect(result).toEqual({ communities: 0, entities: 1 })
    expect(written[0]).toEqual([])
  })
})
