import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import type { KnowledgeStore } from './KnowledgeStore'
import type { KnowledgeEngineConfig } from './knowledge-config'
import type { GraphChatModel } from './GraphService'

/**
 * 社区摘要（GraphRAG 的「全局检索」侧）。
 *
 * 方法学：把整库实体图（节点 = 实体归一键，边 = 关系）交给 Louvain 做社区发现，
 * 每个社区用聊天模型写一段中文主题摘要并落库。作用是回答**整体性问题**
 * （「这批资料都讲了什么」「有哪些主题」）——这类问题在局部检索（片段召回）里
 * 天然找不到依据，社区摘要正好补上。
 *
 * 边界（与微软 GraphRAG 的差异，写清楚避免误解）：
 * - 只做**一层社区**（不分层、不做社区报告的分级 map-reduce）；
 * - 摘要是「实体 + 关系标签 + 代表片段」生成的，不是逐社区 map-reduce 的答案；
 * - 规模上限内做（社区数、社区规模都有上限），桌面单机语料远小于 GraphRAG 的目标场景。
 *
 * 失败可见：与图谱抽取同一条原则——个别社区失败记数并继续，有失败就抛
 * `CommunitySummaryError`，调用方把错误写进可见位置（KB 级 meta），不静默。
 */

/** 单个社区最多纳入摘要的实体数（防止超大社区把提示词撑爆） */
const MAX_ENTITIES_PER_COMMUNITY = 30
/** 最多生成摘要的社区数（按社区规模从大到小） */
const MAX_COMMUNITIES = 12
/** 社区最小规模（小于该规模不生成摘要：一两个实体谈不上「主题」） */
const MIN_COMMUNITY_SIZE = 2
/** 每个实体的代表片段（source_text）最多取多少字符 */
const MAX_EVIDENCE_CHARS = 120

export class CommunitySummaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommunitySummaryError'
  }
}

export interface CommunityServiceDeps {
  store: KnowledgeStore
  /** 解析摘要用的聊天模型（与图谱抽取同一个 graphModel 解析链） */
  resolveModel: (modelName: string) => Promise<GraphChatModel>
}

export interface BuildCommunitiesResult {
  communities: number
  entities: number
}

export interface CommunityRow {
  entityKeys: string[]
  summary: string
}

export class CommunityService {
  private readonly deps: CommunityServiceDeps

  constructor(deps: CommunityServiceDeps) {
    this.deps = deps
  }

  /**
   * 重建某库的社区摘要（先清后写）。
   * 实体图不足以形成社区时返回 0，并把该库的社区清空（保持「与当前图谱一致」）。
   */
  async buildCommunities(input: {
    userId: string
    kbId: string
    config: KnowledgeEngineConfig
    signal?: AbortSignal
  }): Promise<BuildCommunitiesResult> {
    const graphData = this.deps.store.loadKbGraph(input.kbId)
    if (!graphData.entities.length) {
      this.deps.store.replaceCommunities({ kbId: input.kbId, userId: input.userId, communities: [] })
      return { communities: 0, entities: 0 }
    }

    const clusters = detectCommunities(graphData)
    if (!clusters.length) {
      this.deps.store.replaceCommunities({ kbId: input.kbId, userId: input.userId, communities: [] })
      return { communities: 0, entities: graphData.entities.length }
    }

    const model = await this.deps.resolveModel(input.config.graphModel)
    const rows: CommunityRow[] = []
    const failures: string[] = []
    for (const cluster of clusters) {
      if (input.signal?.aborted) throw new CommunitySummaryError('已取消')
      const members = cluster.keys
        .map((key) => graphData.entityIndex.get(key))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, MAX_ENTITIES_PER_COMMUNITY)
      const edgeLines = cluster.edges
        .slice(0, MAX_ENTITIES_PER_COMMUNITY)
        .map(
          (edge) =>
            `${graphData.entityIndex.get(edge.from)?.name ?? edge.from} —${edge.label}→ ${
              graphData.entityIndex.get(edge.to)?.name ?? edge.to
            }`
        )
      const evidence = members
        .map((item) => item.sourceText)
        .filter((text): text is string => Boolean(text))
        .slice(0, 12)
        .map((text) => `- ${text.slice(0, MAX_EVIDENCE_CHARS)}`)
        .join('\n')

      const payload = await summarize(model, { members, edgeLines, evidence }).catch((err) => {
        failures.push(err instanceof Error ? err.message : String(err))
        return null
      })
      if (!payload) continue
      rows.push({ entityKeys: cluster.keys, summary: payload })
    }

    this.deps.store.replaceCommunities({
      kbId: input.kbId,
      userId: input.userId,
      communities: rows
    })

    if (failures.length) {
      throw new CommunitySummaryError(
        `${failures.length}/${clusters.length} 个社区摘要生成失败（已入库 ${rows.length} 条）：${failures[0]}`
      )
    }
    return { communities: rows.length, entities: graphData.entities.length }
  }
}

/** 社区摘要的提示词：只依据给定实体与关系，写一到三句主题概括 */
export const COMMUNITY_SUMMARY_PROMPT = [
  '你是知识库主题归纳助手。下面是同一批资料里频繁共同出现的一组实体及其关系。',
  '请用**一到三句中文**概括这组实体共同描述的主题（主题、领域、它们之间的关系要点）。',
  '只依据给定信息，不要引入外部知识，不要罗列全部实体名。',
  '只输出摘要正文，不要 JSON、不要标题、不要列表符号。'
].join('\n')

async function summarize(
  model: GraphChatModel,
  input: { members: Array<{ name: string; type: string }>; edgeLines: string[]; evidence: string }
): Promise<string> {
  if (!model.complete) throw new Error('模型未提供文本补全能力，无法生成社区摘要')
  const user = [
    `实体（${input.members.length} 个）：`,
    input.members.map((item) => `${item.name}（${item.type}）`).join('、'),
    '',
    input.edgeLines.length ? '关系：' : '关系：（无）',
    input.edgeLines.join('\n'),
    '',
    input.evidence ? '片段摘录：' : '片段摘录：（无）',
    input.evidence
  ].join('\n')
  const text = (await model.complete({ system: COMMUNITY_SUMMARY_PROMPT, user })).trim()
  if (!text) throw new Error('模型没有返回可用摘要')
  return text.slice(0, 800)
}

export interface EntityGraph {
  /** 归一键 → 实体（同名实体跨文档合并，取代表行） */
  entityIndex: Map<string, { name: string; type: string; sourceText: string | null }>
  entities: Array<{ key: string }>
  relations: Array<{ from: string; to: string; label: string }>
}

export interface CommunityCluster {
  keys: string[]
  edges: Array<{ from: string; to: string; label: string }>
}

/**
 * Louvain 社区发现。
 *
 * - 只连「两端都在库内」的边（悬挂边不进图）；
 * - 平行边按次数累加权重（同一关系在多篇文档出现 = 更强关联）；
 * - 结果按社区规模从大到小、只保留 ≥ MIN_COMMUNITY_SIZE 的社区、最多 MAX_COMMUNITIES 个。
 */
export function detectCommunities(graph: EntityGraph): CommunityCluster[] {
  const undirected = new Graph({ type: 'undirected', multi: false })
  for (const key of graph.entityIndex.keys()) undirected.addNode(key)
  for (const relation of graph.relations) {
    if (!graph.entityIndex.has(relation.from) || !graph.entityIndex.has(relation.to)) continue
    if (relation.from === relation.to) continue
    if (undirected.hasEdge(relation.from, relation.to)) {
      // 平行边累加权重（同一关系在多篇文档出现 = 更强关联）
      undirected.updateEdge(relation.from, relation.to, (attributes) => ({
        ...attributes,
        weight: (typeof attributes.weight === 'number' ? attributes.weight : 1) + 1
      }))
    } else {
      undirected.addEdge(relation.from, relation.to, { weight: 1 })
    }
  }
  if (undirected.size === 0) return []

  const assignment = louvain(undirected, { resolution: 1 }) as Record<string, number>
  const byCommunity = new Map<number, string[]>()
  for (const [key, community] of Object.entries(assignment)) {
    const list = byCommunity.get(community)
    if (list) list.push(key)
    else byCommunity.set(community, [key])
  }

  const edgeList = graph.relations.filter(
    (relation) => graph.entityIndex.has(relation.from) && graph.entityIndex.has(relation.to)
  )
  return [...byCommunity.entries()]
    .map(([community, keys]) => ({
      keys,
      edges: edgeList.filter(
        (edge) => assignment[edge.from] === community && assignment[edge.to] === community
      )
    }))
    .filter((cluster) => cluster.keys.length >= MIN_COMMUNITY_SIZE)
    .sort((a, b) => b.keys.length - a.keys.length)
    .slice(0, MAX_COMMUNITIES)
}

/**
 * 全局检索（问答兜底）用：把社区摘要渲染成上下文片段。
 * 无社区时返回空串（调用方保持「没有找到相关内容」的原行为）。
 */
export function renderCommunityContext(rows: CommunityRow[], limit = 3): string {
  const picked = rows.slice(0, limit).filter((row) => row.summary.trim())
  if (!picked.length) return ''
  return [
    '<<<知识库全局主题 开始>>>',
    ...picked.map((row, index) => `[T${index + 1}] ${row.summary}`),
    '<<<知识库全局主题 结束>>>'
  ].join('\n')
}
