import type Database from 'better-sqlite3'
import { normalizeName } from './entity-norm'
import type { KnowledgeGraphView, KnowledgeGraphViewLink, KnowledgeGraphViewNode } from './types'

/**
 * 图谱仓储（R5：KnowledgeStore 拆 Repository 第四刀，纯搬移）。
 *
 * - SQL 与表结构（knowledge_base_entities / _relations / _communities）逐字未动；
 * - KnowledgeStore 保留同名方法作为委托门面（签名/行为不变）；
 * - 文档级清理 `clearForDocTx` 会被切片清理链路（原 clearDocumentIndexTx）在同一
 *   事务内调用；库级 `clearForKbTx` 供删库级联用。
 */

/** 图谱可视化边数上限（SVG 力导向的渲染规模闸门；超出以 truncated 提示） */
const MAX_GRAPH_VIEW_EDGES = 600

export class GraphRepo {
  constructor(private readonly getDb: () => Database.Database) {}

  /** 清某文档的图谱（重抽前先清；删文档时随索引一并清） */
  deleteDocumentGraph(docId: string): void {
    const db = this.getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM knowledge_base_entities WHERE doc_id = ?').run(docId)
      db.prepare('DELETE FROM knowledge_base_relations WHERE doc_id = ?').run(docId)
    })()
  }

  /** 写入某文档的图谱（先清后插，单事务；实体/关系在文档内按归一键去重） */
  replaceDocumentGraph(input: {
    docId: string
    kbId: string
    userId: string
    entities: Array<{
      name: string
      nameKey: string
      type: string
      chunkId: number | null
      chunkIndex: number
      sourceText: string | null
      charStart: number | null
      charEnd: number | null
    }>
    relations: Array<{
      fromEntity: string
      toEntity: string
      fromKey: string
      toKey: string
      label: string
      chunkId: number | null
      description: string | null
    }>
  }): { entities: number; relations: number } {
    const db = this.getDb()
    const now = Date.now()
    const insertEntity = db.prepare(
      `INSERT INTO knowledge_base_entities
        (kb_id, doc_id, chunk_id, user_id, name, name_key, type, mentions, source_text, char_start, char_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    )
    const insertRelation = db.prepare(
      `INSERT INTO knowledge_base_relations
        (kb_id, doc_id, chunk_id, user_id, from_entity, to_entity, from_key, to_key, label, weight, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    const run = db.transaction((): { entities: number; relations: number } => {
      this.clearForDocTx(db, input.docId)
      let entities = 0
      for (const entity of input.entities) {
        insertEntity.run(
          input.kbId,
          input.docId,
          entity.chunkId,
          input.userId,
          entity.name,
          entity.nameKey,
          entity.type,
          entity.sourceText,
          entity.charStart,
          entity.charEnd,
          now
        )
        entities += 1
      }
      let relations = 0
      for (const relation of input.relations) {
        insertRelation.run(
          input.kbId,
          input.docId,
          relation.chunkId,
          input.userId,
          relation.fromEntity,
          relation.toEntity,
          relation.fromKey,
          relation.toKey,
          relation.label,
          relation.description,
          now
        )
        relations += 1
      }
      return { entities, relations }
    })
    return run()
  }

  /** 清某文档的图谱行（在既有事务内调用）：原 clearDocumentGraphTx */
  clearForDocTx(db: Database.Database, docId: string): void {
    db.prepare('DELETE FROM knowledge_base_entities WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM knowledge_base_relations WHERE doc_id = ?').run(docId)
  }

  /** 清整库图谱行（删库级联用，需在既有事务内调用） */
  clearForKbTx(db: Database.Database, kbId: string): void {
    db.prepare('DELETE FROM knowledge_base_entities WHERE kb_id = ?').run(kbId)
    db.prepare('DELETE FROM knowledge_base_relations WHERE kb_id = ?').run(kbId)
    db.prepare('DELETE FROM knowledge_base_communities WHERE kb_id = ?').run(kbId)
  }

  /** 库内实体聚合视图（按 name_key + type 折叠，mentions 为出现次数） */
  listEntities(
    kbId: string,
    limit = 200
  ): Array<{
    name: string
    nameKey: string
    type: string
    mentions: number
  }> {
    const rows = this.getDb()
      .prepare(
        `SELECT name, name_key, type, COUNT(*) AS mentions
         FROM knowledge_base_entities WHERE kb_id = ?
         GROUP BY name_key, type
         ORDER BY mentions DESC, name ASC
         LIMIT ?`
      )
      .all(kbId, limit) as Array<{ name: string; name_key: string; type: string; mentions: number }>
    return rows.map((row) => ({
      name: row.name,
      nameKey: row.name_key,
      type: row.type,
      mentions: row.mentions
    }))
  }

  /**
   * 图谱可视化数据（只读）：节点按 name_key 折叠（代表名/类型取出现最多的一行——
   * SQLite 的 min/max 聚合裸列规则），边按 (from,to,label) 分组后由调用侧折平行边。
   * 悬挂边（端点不在节点集内）与自环在 SQL 后过滤；节点超限则整体截断（truncated）。
   */
  loadKbGraphView(kbId: string, limit = 150): KnowledgeGraphView {
    const db = this.getDb()
    const nodeRows = db
      .prepare(
        `SELECT name_key, name, type, MAX(cnt) AS mentions, SUM(cnt) AS total
         FROM (
           SELECT name_key, name, type, COUNT(*) AS cnt
           FROM knowledge_base_entities WHERE kb_id = ?
           GROUP BY name_key, name, type
         )
         GROUP BY name_key
         ORDER BY total DESC, name_key ASC
         LIMIT ?`
      )
      .all(kbId, limit + 1) as Array<{
      name_key: string
      name: string
      type: string
      mentions: number
      total: number
    }>
    const truncatedNodes = nodeRows.length > limit
    const kept = nodeRows.slice(0, limit)

    // 文档数（跨文档去重）单独聚合后并入（折叠查询里拿不到 doc_id 明细）
    const docsRows = db
      .prepare(
        `SELECT name_key, COUNT(DISTINCT doc_id) AS docs
         FROM knowledge_base_entities WHERE kb_id = ?
         GROUP BY name_key`
      )
      .all(kbId) as Array<{ name_key: string; docs: number }>
    const docsByKey = new Map(docsRows.map((row) => [row.name_key, row.docs]))

    const nodes: KnowledgeGraphViewNode[] = kept.map((row) => ({
      key: row.name_key,
      name: row.name,
      type: row.type,
      mentions: row.total,
      docs: docsByKey.get(row.name_key) ?? 0
    }))
    const inNodes = new Set(nodes.map((node) => node.key))

    const relationRows = db
      .prepare(
        `SELECT from_key, to_key, label, COUNT(*) AS weight
         FROM knowledge_base_relations WHERE kb_id = ?
         GROUP BY from_key, to_key, label
         ORDER BY weight DESC`
      )
      .all(kbId) as Array<{ from_key: string; to_key: string; label: string; weight: number }>

    // 折平行边：同一对实体多条关系合并（weight 求和、labels 采样前 3 条）
    const linkMap = new Map<string, KnowledgeGraphViewLink>()
    for (const row of relationRows) {
      if (row.from_key === row.to_key) continue
      if (!inNodes.has(row.from_key) || !inNodes.has(row.to_key)) continue
      const id = JSON.stringify([row.from_key, row.to_key])
      const existing = linkMap.get(id)
      if (existing) {
        existing.weight += row.weight
        if (existing.labels.length < 3 && !existing.labels.includes(row.label)) {
          existing.labels.push(row.label)
        }
      } else {
        linkMap.set(id, {
          from: row.from_key,
          to: row.to_key,
          labels: [row.label],
          weight: row.weight
        })
      }
    }
    const allLinks = [...linkMap.values()].sort((a, b) => b.weight - a.weight)
    const links = allLinks.slice(0, MAX_GRAPH_VIEW_EDGES)

    return { nodes, links, truncated: truncatedNodes || links.length < allLinks.length }
  }

  countGraphEntities(kbId: string): number {
    const row = this.getDb()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }

  /** 某文档的图谱（重抽后回写文档级计数用） */
  countDocumentGraph(docId: string): { entities: number; relations: number } {
    const db = this.getDb()
    const entities = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_entities WHERE doc_id = ?')
      .get(docId) as { c: number }
    const relations = db
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_relations WHERE doc_id = ?')
      .get(docId) as { c: number }
    return { entities: entities.c, relations: relations.c }
  }

  /** 某文档的实体名（重抽失败提示 / 前端展示用） */
  listDocumentGraph(docId: string): Array<{ name: string; nameKey: string; type: string }> {
    const rows = this.getDb()
      .prepare('SELECT name, name_key, type FROM knowledge_base_entities WHERE doc_id = ?')
      .all(docId) as Array<{ name: string; name_key: string; type: string }>
    return rows.map((row) => ({ name: row.name, nameKey: row.name_key, type: row.type }))
  }

  /**
   * 图谱扩展召回（检索侧第三路）。
   *
   * 1. 用归一键在查询串里找**种子实体**：`instr(查询串归一, name_key) > 0`
   *    （SQLite 的 instr 即子串匹配；名字长度 ≥ 2 避免单字误命中）；
   * 2. 沿关系找一跳邻居（from_key/to_key 任一命中即算）；
   * 3. 把这些实体的 `chunk_id` 作为候选切片返回（跳过 NULL）。
   *
   * 返回 `{ chunkIds, seedNames }`：seedNames 供问答上下文提示「知识关联」用。
   */
  graphExpand(input: {
    kbId: string
    userId: string
    query: string
    limit: number
  }): { chunkIds: number[]; seedNames: string[] } {
    const db = this.getDb()
    const normalizedQuery = normalizeName(input.query)
    if (!normalizedQuery) return { chunkIds: [], seedNames: [] }

    const seeds = db
      .prepare(
        `SELECT DISTINCT name_key, name FROM knowledge_base_entities
         WHERE kb_id = ? AND user_id = ? AND length(name_key) >= 2 AND instr(?, name_key) > 0
         LIMIT 20`
      )
      .all(input.kbId, input.userId, normalizedQuery) as Array<{ name_key: string; name: string }>
    if (!seeds.length) return { chunkIds: [], seedNames: [] }
    const seedKeys = seeds.map((row) => row.name_key)

    // 一跳邻居（含种子自身）
    const neighborKeys = new Set<string>(seedKeys)
    const placeholders = seedKeys.map(() => '?').join(',')
    const relations = db
      .prepare(
        `SELECT from_key, to_key FROM knowledge_base_relations
         WHERE kb_id = ? AND user_id = ?
           AND (from_key IN (${placeholders}) OR to_key IN (${placeholders}))`
      )
      .all(input.kbId, input.userId, ...seedKeys, ...seedKeys) as Array<{
      from_key: string
      to_key: string
    }>
    for (const relation of relations) {
      neighborKeys.add(relation.from_key)
      neighborKeys.add(relation.to_key)
    }

    const keys = [...neighborKeys]
    const keyPlaceholders = keys.map(() => '?').join(',')
    const chunks = db
      .prepare(
        `SELECT DISTINCT chunk_id FROM knowledge_base_entities
         WHERE kb_id = ? AND user_id = ? AND chunk_id IS NOT NULL AND name_key IN (${keyPlaceholders})
         LIMIT ?`
      )
      .all(input.kbId, input.userId, ...keys, input.limit) as Array<{ chunk_id: number }>

    return {
      chunkIds: chunks.map((row) => row.chunk_id),
      seedNames: seeds.map((row) => row.name)
    }
  }

  /** 载入整库实体图（跨文档按归一键折叠；供社区发现用） */
  loadKbGraph(kbId: string): {
    entityIndex: Map<string, { name: string; type: string; sourceText: string | null }>
    entities: Array<{ key: string }>
    relations: Array<{ from: string; to: string; label: string }>
  } {
    const db = this.getDb()
    const entityRows = db
      .prepare(
        `SELECT name_key, name, type, source_text FROM knowledge_base_entities WHERE kb_id = ?`
      )
      .all(kbId) as Array<{
      name_key: string
      name: string
      type: string
      source_text: string | null
    }>
    const entityIndex = new Map<string, { name: string; type: string; sourceText: string | null }>()
    for (const row of entityRows) {
      // 同名跨文档只留一条（名字/类型取首次出现的；source_text 取第一条非空的）
      const existing = entityIndex.get(row.name_key)
      if (existing) {
        if (!existing.sourceText && row.source_text) existing.sourceText = row.source_text
        continue
      }
      entityIndex.set(row.name_key, {
        name: row.name,
        type: row.type,
        sourceText: row.source_text
      })
    }
    const relationRows = db
      .prepare(
        `SELECT from_key, to_key, label FROM knowledge_base_relations WHERE kb_id = ?`
      )
      .all(kbId) as Array<{ from_key: string; to_key: string; label: string }>
    return {
      entityIndex,
      entities: [...entityIndex.keys()].map((key) => ({ key })),
      relations: relationRows.map((row) => ({
        from: row.from_key,
        to: row.to_key,
        label: row.label
      }))
    }
  }

  /** 替换某库的社区摘要（先清后写，单事务；空数组 = 清空） */
  replaceCommunities(input: {
    kbId: string
    userId: string
    communities: Array<{ entityKeys: string[]; summary: string }>
  }): number {
    const db = this.getDb()
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO knowledge_base_communities (kb_id, user_id, level, entity_keys, summary, entity_count, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?)`
    )
    const run = db.transaction((): number => {
      db.prepare('DELETE FROM knowledge_base_communities WHERE kb_id = ?').run(input.kbId)
      for (const community of input.communities) {
        insert.run(
          input.kbId,
          input.userId,
          JSON.stringify(community.entityKeys),
          community.summary,
          community.entityKeys.length,
          now
        )
      }
      return input.communities.length
    })
    return run()
  }

  /** 读某库的社区摘要（按社区规模从大到小） */
  listCommunities(kbId: string, limit = 12): Array<{ entityKeys: string[]; summary: string }> {
    const rows = this.getDb()
      .prepare(
        `SELECT entity_keys, summary FROM knowledge_base_communities
         WHERE kb_id = ? ORDER BY entity_count DESC, id ASC LIMIT ?`
      )
      .all(kbId, limit) as Array<{ entity_keys: string; summary: string }>
    return rows.map((row) => {
      let entityKeys: string[] = []
      try {
        const parsed = JSON.parse(row.entity_keys) as unknown
        if (Array.isArray(parsed))
          entityKeys = parsed.filter((item): item is string => typeof item === 'string')
      } catch {
        entityKeys = []
      }
      return { entityKeys, summary: row.summary }
    })
  }

  countCommunities(kbId: string): number {
    const row = this.getDb()
      .prepare('SELECT COUNT(*) AS c FROM knowledge_base_communities WHERE kb_id = ?')
      .get(kbId) as { c: number }
    return row.c
  }
}
