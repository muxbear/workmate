import { z } from 'zod'
import { canonicalType, normalizeName, ENTITY_TYPES } from './entity-norm'
import type { KnowledgeStore } from './KnowledgeStore'
import type { KnowledgeEngineConfig } from './knowledge-config'

/**
 * 知识图谱抽取（GraphRAG 局部检索的索引侧）。
 *
 * 方法学对齐微软 GraphRAG / web 后端 LangExtract 版：
 * - **8 类受控实体 + 原文定位**：`source_text` 必须是窗口原文的精确子串，
 *   校验不过就丢弃（幻觉实体不入库）；
 * - **关系两端必须是本次抽出的实体**（精确同名），否则丢弃；
 * - **失败绝不静默**（历史事故教训）：单个窗口失败记数并继续，
 *   只要有窗口失败就抛 `GraphExtractionError`，由索引服务写入 `graph_error`
 *   —— 已抽到的部分仍然入库，错误对用户可见、可按文档重抽。
 *
 * 抽取用聊天模型的结构化输出（LangChain `withStructuredOutput`，桌面端没有 langextract，
 * 用工具调用等价实现）；模型不可用/报错同样走失败可见路径。
 */

/** 单个抽取窗口的字符上限（合并相邻切片到 ~2000 字符，控制单次请求规模） */
const WINDOW_CHARS = 2000
/** 每个窗口的重试次数（提示词约束较强，偶发格式问题重试一次足够） */
const MAX_ATTEMPTS = 2

export class GraphExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphExtractionError'
  }
}

/**
 * 结构化输出 schema：字段全部 required（OpenAI 严格模式不接受 optional），
 * 不适用的字段让模型给空串 —— 转换侧把空串当作「没有」。
 */
export const GRAPH_EXTRACTION_SCHEMA = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe('实体原文（必须是输入文本里的精确片段）'),
      type: z.enum(ENTITY_TYPES).describe('实体类型'),
      source_text: z.string().describe('实体所在的原文片段（精确子串；没有就给空串）')
    })
  ),
  relations: z.array(
    z.object({
      from: z.string().describe('关系起始实体（必须与某个 entity 的 name 完全一致）'),
      to: z.string().describe('关系目标实体（必须与某个 entity 的 name 完全一致）'),
      label: z.string().describe('关系标签，如 开发/使用/基于/包含/发布于/隶属于'),
      description: z.string().describe('关系的一句话说明；没有就给空串')
    })
  )
})

/** 抽取结果的结构化契约（与提示词里要求的 JSON 形状一致） */
export interface GraphExtractionPayload {
  entities: Array<{ name: string; type: string; source_text?: string }>
  relations: Array<{ from: string; to: string; label: string; description?: string }>
}

/**
 * 判断错误是否为「思考模式不接受强制 tool_choice」类拒绝。
 *
 * 实测：`deepseek-v4-flash`（思考模式）对 function calling 的**强制 tool_choice**
 * 返回 400 `Thinking mode does not support this tool_choice`（模型库里却标着
 * supportsToolCall=true）。命中即降级为纯文本 JSON 抽取（见 index.ts 的调用侧）。
 */
export function isToolChoiceRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (/tool[_ ]?choice/i.test(message)) return true
  return /thinking mode/i.test(message) && /tool/i.test(message)
}

/**
 * 纯文本抽取结果的容错解析（降级路径用；提示词本来就要求「只输出 JSON」）。
 * 容忍 ```json 围栏与前后夹带的说明文字：取第一个「括号配平」的 JSON 对象；
 * 结构做宽松归一（缺字段补默认、非数组容错），**语义校验仍在 convertExtraction**
 * （实体名/原文子串/关系两端一致性）——这里不重复做。
 */
export function parseExtractionText(text: string): GraphExtractionPayload {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('抽取模型返回了空文本')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.indexOf('{')
  if (start < 0) throw new Error('抽取模型未返回 JSON 对象')
  const end = findBalancedBraceEnd(candidate, start)
  if (end < 0) throw new Error('抽取模型返回的 JSON 不完整')
  let value: unknown
  try {
    value = JSON.parse(candidate.slice(start, end + 1))
  } catch (err) {
    throw new Error(`抽取模型返回的 JSON 无法解析：${(err as Error).message}`)
  }
  if (typeof value !== 'object' || value === null) throw new Error('抽取结果不是 JSON 对象')
  const record = value as Record<string, unknown>
  const entities = toArray(record.entities)
    .map((item) => toRecord(item))
    .map((item) => ({
      name: str(item.name),
      type: str(item.type) || '概念',
      source_text: str(item.source_text)
    }))
    .filter((item) => item.name)
  const relations = toArray(record.relations)
    .map((item) => toRecord(item))
    .map((item) => ({
      from: str(item.from),
      to: str(item.to),
      label: str(item.label) || '相关',
      description: str(item.description)
    }))
    .filter((item) => item.from && item.to)
  return { entities, relations }
}

/** 从 start 处的 `{` 起找括号配平（跳过字符串内的花括号与转义）的闭合位置；找不到返回 -1 */
function findBalancedBraceEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 聊天模型适配（生产注入真实模型；单测注入替身）。
 * - `extract`：结构化抽取（withStructuredOutput + function calling）；
 * - `complete`：纯文本生成（社区摘要用；缺省时社区摘要给出明确的失败，不静默）。
 */
export interface GraphChatModel {
  extract: (input: { system: string; user: string }) => Promise<GraphExtractionPayload>
  complete?: (input: { system: string; user: string }) => Promise<string>
}

export interface GraphServiceDeps {
  store: KnowledgeStore
  /** 解析抽取用的聊天模型（模型名取生效配置的 graphModel） */
  resolveModel: (modelName: string) => Promise<GraphChatModel>
}

export interface GraphExtractionInput {
  userId: string
  kbId: string
  docId: string
  chunks: Array<{ id: number; index: number; content: string }>
  config: KnowledgeEngineConfig
  signal?: AbortSignal
}

export class GraphService {
  private readonly deps: GraphServiceDeps

  constructor(deps: GraphServiceDeps) {
    this.deps = deps
  }

  /**
   * 抽取并落库某文档的图谱（先清旧、再按窗口抽、单事务写入）。
   * 返回入库计数；有窗口失败时**先落库已抽到的部分再抛错**（错误可见）。
   */
  async extract(input: GraphExtractionInput): Promise<{
    entities: number
    relations: number
  }> {
    const windows = buildWindows(input.chunks)
    if (!windows.length) return { entities: 0, relations: 0 }

    const model = await this.deps.resolveModel(input.config.graphModel)

    const entities: Array<{
      name: string
      nameKey: string
      type: string
      chunkId: number | null
      chunkIndex: number
      sourceText: string | null
      charStart: number | null
      charEnd: number | null
    }> = []
    const relations: Array<{
      fromEntity: string
      toEntity: string
      fromKey: string
      toKey: string
      label: string
      chunkId: number | null
      description: string | null
    }> = []
    const failures: string[] = []

    for (let index = 0; index < windows.length; index += 1) {
      if (input.signal?.aborted) throw new GraphExtractionError('已取消')
      const window = windows[index]
      let payload: GraphExtractionPayload | null = null
      let lastError = ''
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !payload; attempt += 1) {
        try {
          payload = await model.extract({ system: EXTRACTION_SYSTEM_PROMPT, user: window.text })
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }
      if (!payload) {
        failures.push(`窗口 ${index + 1}/${windows.length}：${lastError || '抽取失败'}`)
        continue
      }
      const converted = convertExtraction(window, payload)
      entities.push(...converted.entities)
      relations.push(...converted.relations)
    }

    // 去重（同文档内同键只留一条；mentions 语义由查询侧 COUNT 聚合）
    const uniqueEntities = dedupeBy(entities, (item) => `${item.nameKey}|${item.type}`)
    const validKeys = new Set(uniqueEntities.map((item) => `${item.nameKey}|${item.type}`))
    const uniqueRelations = dedupeBy(
      relations.filter((relation) => {
        // 关系两端必须在本次抽出的实体里（避免指向不存在实体的悬挂边）
        // 两端都必须在本次抽出的实体里（悬挂边不入库；自环已在 convertExtraction 过滤）
        return hasKey(validKeys, relation.fromKey) && hasKey(validKeys, relation.toKey)
      }),
      (item) => `${item.fromKey}|${item.toKey}|${item.label}`
    )

    const written = this.deps.store.replaceDocumentGraph({
      docId: input.docId,
      kbId: input.kbId,
      userId: input.userId,
      entities: uniqueEntities,
      relations: uniqueRelations
    })

    if (failures.length) {
      throw new GraphExtractionError(
        `${failures.length}/${windows.length} 个窗口抽取失败（已入库 ${written.entities} 实体 / ${written.relations} 关系）：${failures[0]}`
      )
    }
    return written
  }
}

/** 系统提示词（移植 web `graph_service.py` 的抽取约束，改成结构化输出契约） */
export const EXTRACTION_SYSTEM_PROMPT = [
  '从文本中提取实体和实体之间的关系。仅提取文本中明确出现的实体和关系，不要虚构。',
  '',
  `实体类型必须是以下之一：${ENTITY_TYPES.join('、')}。`,
  '软件框架、模型、数据集这类具体的产物归「产品」；技术方案、方法这类抽象概念归「概念」。',
  '',
  '每个 entity 的 name 必须是文本中出现的精确原文片段（不得改写、不得翻译），',
  'source_text 给出该实体所在的原文片段（同样必须是精确子串）。',
  '',
  '每个 relation 的 from / to 必须与某个已提取 entity 的 name 完全一致（含标点与空格），',
  'label 用简短的关系词（如「开发」「使用」「基于」「包含」「发布于」「隶属于」）。',
  '',
  '只输出 JSON：{"entities":[{"name":"...","type":"...","source_text":"..."}],',
  '"relations":[{"from":"...","to":"...","label":"...","description":"..."}]}。',
  '没有实体或关系时返回空数组。'
].join('\n')

/**
 * 把相邻切片合并成抽取窗口（每窗 ≤ WINDOW_CHARS，至少保留一个切片）。
 * 保留 chunk 引用，抽取结果回填 chunk_id 用。
 */
export function buildWindows(
  chunks: Array<{ id: number; index: number; content: string }>
): Array<{ text: string; chunks: Array<{ id: number; index: number; content: string }> }> {
  const windows: Array<{ text: string; chunks: Array<{ id: number; index: number; content: string }> }> = []
  let current: { text: string; chunks: Array<{ id: number; index: number; content: string }> } | null = null
  for (const chunk of chunks) {
    if (!current) {
      current = { text: chunk.content, chunks: [chunk] }
      continue
    }
    if (current.text.length + chunk.content.length + 2 > WINDOW_CHARS) {
      windows.push(current)
      current = { text: chunk.content, chunks: [chunk] }
      continue
    }
    current.text += `\n\n${chunk.content}`
    current.chunks.push(chunk)
  }
  if (current) windows.push(current)
  return windows
}

/**
 * 抽取结果 → 可入库行：
 * - 实体名必须在窗口原文里出现（`source_text` 也校验是子串，缺失时回退成实体名）；
 * - 类型走 `canonicalType`（旧词表折叠 / 未知回退「概念」）；
 * - chunk_id 取窗口内**首个包含该实体名**的切片。
 */
export function convertExtraction(
  window: { text: string; chunks: Array<{ id: number; index: number; content: string }> },
  payload: GraphExtractionPayload
): {
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
} {
  const entities: ReturnType<typeof convertExtraction>['entities'] = []
  const nameToKey = new Map<string, string>()
  for (const raw of payload.entities ?? []) {
    const name = String(raw?.name ?? '').trim()
    if (!name || !window.text.includes(name)) continue
    const nameKey = normalizeName(name)
    if (!nameKey) continue
    const sourceText = pickSourceText(window.text, name, raw?.source_text)
    const owner = window.chunks.find((chunk) => chunk.content.includes(name)) ?? window.chunks[0]
    const offset = owner.content.indexOf(name)
    entities.push({
      name,
      nameKey,
      type: canonicalType(raw?.type),
      chunkId: owner.id,
      chunkIndex: owner.index,
      sourceText,
      charStart: offset >= 0 ? offset : null,
      charEnd: offset >= 0 ? offset + name.length : null
    })
    if (!nameToKey.has(name)) nameToKey.set(name, nameKey)
  }

  const relations = (payload.relations ?? [])
    .map((raw) => {
      const from = String(raw?.from ?? '').trim()
      const to = String(raw?.to ?? '').trim()
      const label = String(raw?.label ?? '').trim()
      if (!from || !to || !label) return null
      const fromKey = nameToKey.get(from)
      const toKey = nameToKey.get(to)
      if (!fromKey || !toKey || fromKey === toKey) return null
      const owner =
        window.chunks.find((chunk) => chunk.content.includes(from) && chunk.content.includes(to)) ??
        window.chunks.find((chunk) => chunk.content.includes(from)) ??
        window.chunks[0]
      return {
        fromEntity: from,
        toEntity: to,
        fromKey,
        toKey,
        label,
        chunkId: owner.id,
        description: raw?.description ? String(raw.description).slice(0, 500) : null
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)

  return { entities, relations }
}

/** source_text 校验：必须是原文子串；不合法时回退为实体名 */
function pickSourceText(text: string, name: string, candidate: unknown): string {
  const raw = typeof candidate === 'string' ? candidate.trim() : ''
  if (raw && text.includes(raw)) return raw.slice(0, 500)
  return name
}

function hasKey(keys: Set<string>, nameKey: string): boolean {
  for (const key of keys) {
    if (key.startsWith(`${nameKey}|`)) return true
  }
  return false
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
