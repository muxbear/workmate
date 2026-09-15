import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../../preload/index.d'

/**
 * 知识库配置字段描述表与草稿工具
 *
 * 这是渲染层 17 项配置的**唯一来源**：「知识库设置」页（全局）与每个知识库的设置弹窗
 * （按库覆盖）共用同一份字段定义、同一套控件与校验区间，避免两处漂移。
 * 区间/枚举与主进程 src/main/knowledge/knowledge-schema.ts 保持一致（主进程仍是最终权威）。
 */

export type KnowledgeDraftValue = string | number | boolean
/** 表单草稿：17 项齐备；数值项以字符串承接（保存时统一解析校验） */
export type KnowledgeDraft = Record<KnowledgeOverrideKey, KnowledgeDraftValue>

export interface KnowledgeFieldDef {
  key: KnowledgeOverrideKey
  label: string
  kind: 'number' | 'select' | 'boolean'
  /** number：区间（与主进程 schema 一致） */
  min?: number
  max?: number
  integer?: boolean
  /** number：单位后缀（MB / 分钟 / tokens …） */
  unit?: string
  /** select：候选项 */
  options?: ReadonlyArray<{ value: string | number; label: string }>
  /** select：额外追加 models.json 中的自定义模型名 */
  withCustomModels?: boolean
}

const CHUNK_STRATEGY_OPTIONS: KnowledgeFieldDef['options'] = [
  { value: 'semantic', label: '智能语义切分' },
  { value: 'fixed', label: '固定长度切分' },
  { value: 'markdown', label: '按 Markdown 标题切分' },
  { value: 'recursive', label: '递归字符切分' }
]

const VECTOR_DIMENSION_OPTIONS: KnowledgeFieldDef['options'] = [
  { value: 1024, label: '1024' },
  { value: 1536, label: '1536' },
  { value: 3072, label: '3072' }
]

const EMBEDDING_MODEL_OPTIONS: KnowledgeFieldDef['options'] = [
  { value: 'text-embedding-3-large', label: 'text-embedding-3-large' },
  { value: 'bge-m3', label: 'bge-m3' }
]

const RERANK_MODEL_OPTIONS: KnowledgeFieldDef['options'] = [
  { value: 'bge-reranker-v2-m3', label: 'bge-reranker-v2-m3' },
  { value: 'gte-reranker-modernbert-base', label: 'gte-reranker-modernbert-base' }
]

const GRAPH_MODEL_OPTIONS: KnowledgeFieldDef['options'] = [
  { value: 'GLM-5', label: 'GLM-5' },
  { value: 'DeepSeek-V4-Pro 原厂直供', label: 'DeepSeek-V4-Pro 原厂直供' }
]

/** 内置模型名（用于过滤 models.json 中重名的自定义模型） */
export const BUILTIN_MODEL_OPTIONS: readonly string[] = [
  ...(EMBEDDING_MODEL_OPTIONS ?? []),
  ...(RERANK_MODEL_OPTIONS ?? []),
  ...(GRAPH_MODEL_OPTIONS ?? [])
].map((opt) => String(opt.value))

/** 字段声明顺序 = 弹窗与设置页的渲染顺序（按卡片分组） */
export const KNOWLEDGE_FIELD_LIST: readonly KnowledgeFieldDef[] = [
  // ── 文件上传 ──
  {
    key: 'maxUploadSize',
    label: '单文件最大大小',
    kind: 'number',
    min: 1,
    max: 10240,
    integer: true,
    unit: 'MB'
  },
  {
    key: 'uploadTimeout',
    label: '上传超时',
    kind: 'number',
    min: 1,
    max: 600,
    integer: true,
    unit: '分钟'
  },
  {
    key: 'maxFilesPerBatch',
    label: '单批次文件数',
    kind: 'number',
    min: 1,
    max: 1000,
    integer: true,
    unit: '个'
  },
  // ── RAG 索引 ──
  { key: 'chunkStrategy', label: '默认切片算法', kind: 'select', options: CHUNK_STRATEGY_OPTIONS },
  {
    key: 'embeddingModel',
    label: '向量化模型',
    kind: 'select',
    options: EMBEDDING_MODEL_OPTIONS,
    withCustomModels: true
  },
  {
    key: 'chunkSize',
    label: '切片大小',
    kind: 'number',
    min: 100,
    max: 8192,
    integer: true,
    unit: 'tokens'
  },
  {
    key: 'chunkOverlap',
    label: '重叠大小',
    kind: 'number',
    min: 0,
    max: 4096,
    integer: true,
    unit: 'tokens'
  },
  { key: 'vectorDimensions', label: '向量维度', kind: 'select', options: VECTOR_DIMENSION_OPTIONS },
  // ── 混合检索与重排 ──
  { key: 'sparseRetrieval', label: '稀疏检索', kind: 'boolean' },
  { key: 'bm25K1', label: 'BM25 k1', kind: 'number', min: 0, max: 10, integer: false },
  { key: 'bm25B', label: 'BM25 b', kind: 'number', min: 0, max: 1, integer: false },
  { key: 'hybridWeight', label: '向量检索权重', kind: 'number', min: 0, max: 1, integer: false },
  { key: 'rerankEnabled', label: '启用重排', kind: 'boolean' },
  {
    key: 'rerankModel',
    label: '重排模型',
    kind: 'select',
    options: RERANK_MODEL_OPTIONS,
    withCustomModels: true
  },
  { key: 'topK', label: '召回 Top', kind: 'number', min: 1, max: 100, integer: true },
  // ── 知识图谱抽取 ──
  { key: 'graphEnabled', label: '知识图谱抽取', kind: 'boolean' },
  {
    key: 'graphModel',
    label: '抽取模型',
    kind: 'select',
    options: GRAPH_MODEL_OPTIONS,
    withCustomModels: true
  }
]

export const KNOWLEDGE_FIELD_DEFS: Record<KnowledgeOverrideKey, KnowledgeFieldDef> =
  KNOWLEDGE_FIELD_LIST.reduce(
    (acc, field) => {
      acc[field.key] = field
      return acc
    },
    {} as Record<KnowledgeOverrideKey, KnowledgeFieldDef>
  )

/** 可覆盖项清单（顺序同字段声明顺序；与主进程派生清单一致，由单测钉住） */
export const KNOWLEDGE_OVERRIDE_KEYS: readonly KnowledgeOverrideKey[] = KNOWLEDGE_FIELD_LIST.map(
  (field) => field.key
)

/** 由生效值构造表单草稿（17 项齐备；数值转字符串） */
export function createDraft(values: KnowledgeOverrides): KnowledgeDraft {
  const draft = {} as KnowledgeDraft
  for (const field of KNOWLEDGE_FIELD_LIST) {
    const raw = values[field.key]
    if (field.kind === 'number') {
      draft[field.key] = raw === undefined || raw === null ? '' : String(raw)
    } else if (field.kind === 'boolean') {
      draft[field.key] = raw === true
    } else {
      draft[field.key] = (raw ?? '') as string | number
    }
  }
  return draft
}

/** 数值解析 + 区间校验；非法返回 null（与主进程 schema 边界一致） */
export function parseNumber(
  raw: string,
  min: number,
  max: number,
  integer: boolean
): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  if (integer && !Number.isInteger(n)) return null
  if (n < min || n > max) return null
  return n
}

/**
 * 单字段草稿值 → 可提交的配置值。
 * 支持自定义模型名（不在候选项中但非空）；非法时返回带字段名的错误文案。
 */
export function draftValueToOverride(
  field: KnowledgeFieldDef,
  raw: KnowledgeDraftValue
): { value: unknown } | { error: string } {
  if (field.kind === 'boolean') return { value: raw === true }
  if (field.kind === 'number') {
    const min = field.min ?? 0
    const max = field.max ?? Number.MAX_SAFE_INTEGER
    const n = parseNumber(String(raw), min, max, field.integer === true)
    if (n === null) {
      return {
        error: `「${field.label}」需为 ${min}~${max} 之间的${field.integer ? '整数' : '数值'}`
      }
    }
    return { value: n }
  }
  const text = String(raw ?? '').trim()
  if (!text) return { error: `「${field.label}」不能为空` }
  // 命中候选项时回落到其原始类型（向量维度为数字）；自定义模型名按文本提交
  const option = field.options?.find((item) => String(item.value) === text)
  if (option) return { value: option.value }
  if (field.withCustomModels) return { value: text }
  return { error: `「${field.label}」取值非法` }
}
