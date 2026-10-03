import { createHash } from 'crypto'
import type { KnowledgeOverrideKey } from './knowledge-schema'
import type { KnowledgeChunkStrategy } from './types'

/** 全局独占（不参与按库覆盖）的知识库配置项（短 key） */
type GlobalOnlyKey = 'embeddingBaseUrl' | 'embeddingApiKey' | 'rerankBaseUrl' | 'rerankApiKey'

/**
 * 生效配置 → 引擎消费的强类型视图。
 *
 * 配置三层来源（全局 ← 按库覆盖 → 上传快照）的合并已由
 * `KnowledgeSettingsService.getEffective()` 完成；本模块只负责：
 * 1. 把 `Record<key, unknown>` 收成引擎直接可用的类型（容错：越界/缺失回退默认）；
 * 2. 生成**上传快照**（14 个索引项）与**索引口径指纹**（配置变了才需要重建）。
 */

/** 索引相关配置项（上传快照包含的项；与渲染层 uploadIndex.ts 的 INDEX_FIELD_KEYS 对应） */
export const INDEX_SNAPSHOT_KEYS = [
  'chunkStrategy',
  'chunkSize',
  'chunkOverlap',
  'embeddingModel',
  'vectorDimensions',
  'sparseRetrieval',
  'bm25K1',
  'bm25B',
  'hybridWeight',
  'rerankEnabled',
  'rerankModel',
  'topK',
  'graphEnabled',
  'graphModel'
] as const satisfies readonly KnowledgeOverrideKey[]

/** 影响「索引产物」的配置项（检索侧参数不参与指纹：改 topK 不需要重建索引） */
const SIGNATURE_KEYS = [
  'chunkStrategy',
  'chunkSize',
  'chunkOverlap',
  'embeddingModel',
  'vectorDimensions',
  'graphEnabled',
  'graphModel'
] as const satisfies readonly KnowledgeOverrideKey[]

export interface KnowledgeEngineConfig {
  chunkStrategy: KnowledgeChunkStrategy
  chunkSize: number
  chunkOverlap: number
  embeddingModel: string
  vectorDimensions: number
  /** 嵌入端点（全局项，不进按库覆盖） */
  embeddingBaseUrl: string
  embeddingApiKey: string
  sparseRetrieval: boolean
  bm25K1: number
  bm25B: number
  hybridWeight: number
  rerankEnabled: boolean
  rerankModel: string
  rerankBaseUrl: string
  rerankApiKey: string
  topK: number
  /** 稠密检索相似度门限（0 = 关闭） */
  minSimilarity: number
  /** 查询改写（默认关闭；开启后多一次模型调用换召回率） */
  queryRewriteEnabled: boolean
  /** MMR 去冗余（默认关闭；对融合候选按 token 冗余度贪心重选，压掉近重复切片） */
  mmrEnabled: boolean
  /** MMR 相关度权重 λ（0~1，越大越偏相关度、越小越偏多样性） */
  mmrLambda: number
  /** 时间衰减半衰期（天，0 = 关闭）：按文档导入时间对最终分数加权 */
  timeDecayHalfLifeDays: number
  graphEnabled: boolean
  graphModel: string
}

const FALLBACK: KnowledgeEngineConfig = {
  chunkStrategy: 'recursive',
  chunkSize: 800,
  chunkOverlap: 120,
  embeddingModel: '',
  vectorDimensions: 1024,
  embeddingBaseUrl: '',
  embeddingApiKey: '',
  sparseRetrieval: true,
  bm25K1: 1.5,
  bm25B: 0.75,
  hybridWeight: 0.65,
  rerankEnabled: false,
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  topK: 12,
  minSimilarity: 0.53,
  queryRewriteEnabled: false,
  mmrEnabled: false,
  mmrLambda: 0.7,
  timeDecayHalfLifeDays: 0,
  graphEnabled: false,
  graphModel: ''
}

/**
 * 把生效配置收成强类型。
 *
 * - `effective`：`getEffective().effective`（22 项按库可覆盖的短 key）；
 * - `global`：全局设置快照（补 4 个端点 key —— 它们不参与按库覆盖）。
 */
export function toEngineConfig(
  effective: Record<string, unknown>,
  global: Record<string, unknown>
): KnowledgeEngineConfig {
  const read = (key: KnowledgeOverrideKey, fallback: unknown): unknown => {
    const value = effective[key]
    return value === undefined ? fallback : value
  }
  /** 全局独占项（不进按库覆盖）：直接用 settings key 读全局快照 */
  const readGlobal = (key: GlobalOnlyKey): unknown => global[`knowledge.${key}`]
  const strategy = read('chunkStrategy', FALLBACK.chunkStrategy) as string

  return {
    chunkStrategy: (['semantic', 'fixed', 'markdown', 'recursive'] as const).includes(
      strategy as KnowledgeChunkStrategy
    )
      ? (strategy as KnowledgeChunkStrategy)
      : FALLBACK.chunkStrategy,
    chunkSize: positiveInt(read('chunkSize', FALLBACK.chunkSize), FALLBACK.chunkSize),
    chunkOverlap: nonNegativeInt(read('chunkOverlap', FALLBACK.chunkOverlap), FALLBACK.chunkOverlap),
    embeddingModel: str(read('embeddingModel', FALLBACK.embeddingModel)),
    vectorDimensions: positiveInt(
      read('vectorDimensions', FALLBACK.vectorDimensions),
      FALLBACK.vectorDimensions
    ),
    embeddingBaseUrl: str(readGlobal('embeddingBaseUrl')).trim(),
    embeddingApiKey: str(readGlobal('embeddingApiKey')),
    sparseRetrieval: bool(read('sparseRetrieval', FALLBACK.sparseRetrieval), FALLBACK.sparseRetrieval),
    bm25K1: num(read('bm25K1', FALLBACK.bm25K1), FALLBACK.bm25K1),
    bm25B: num(read('bm25B', FALLBACK.bm25B), FALLBACK.bm25B),
    hybridWeight: num(read('hybridWeight', FALLBACK.hybridWeight), FALLBACK.hybridWeight),
    rerankEnabled: bool(read('rerankEnabled', FALLBACK.rerankEnabled), FALLBACK.rerankEnabled),
    rerankModel: str(read('rerankModel', FALLBACK.rerankModel)),
    rerankBaseUrl: str(readGlobal('rerankBaseUrl')).trim(),
    rerankApiKey: str(readGlobal('rerankApiKey')),
    topK: positiveInt(read('topK', FALLBACK.topK), FALLBACK.topK),
    minSimilarity: clamp01(num(read('minSimilarity', FALLBACK.minSimilarity), FALLBACK.minSimilarity)),
    queryRewriteEnabled: bool(
      read('queryRewriteEnabled', FALLBACK.queryRewriteEnabled),
      FALLBACK.queryRewriteEnabled
    ),
    mmrEnabled: bool(read('mmrEnabled', FALLBACK.mmrEnabled), FALLBACK.mmrEnabled),
    mmrLambda: clamp01(num(read('mmrLambda', FALLBACK.mmrLambda), FALLBACK.mmrLambda)),
    timeDecayHalfLifeDays: nonNegativeInt(
      read('timeDecayHalfLifeDays', FALLBACK.timeDecayHalfLifeDays),
      FALLBACK.timeDecayHalfLifeDays
    ),
    graphEnabled: bool(read('graphEnabled', FALLBACK.graphEnabled), FALLBACK.graphEnabled),
    graphModel: str(read('graphModel', FALLBACK.graphModel))
  }
}

/** 上传快照：只取 14 个索引项（JSON 字符串直接落 `knowledge_base_documents.config`） */
export function pickIndexSnapshot(config: KnowledgeEngineConfig): string {
  const snapshot: Record<string, unknown> = {}
  for (const key of INDEX_SNAPSHOT_KEYS) snapshot[key] = config[key]
  return JSON.stringify(snapshot)
}

/** 校验上传传入的配置快照：只认索引项，值类型与引擎视图一致（主进程为权威，防渲染层绕过） */
export function normalizeIndexSnapshot(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of INDEX_SNAPSHOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (!isSnapshotValueValid(key, value)) {
      throw new Error(`索引配置「${key}」的值非法：${JSON.stringify(value)}`)
    }
    out[key] = value
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

/** 由（可能不完整的）快照覆盖生效配置：上传时的自定义索引仅影响当次文档 */
export function overlaySnapshot(
  config: KnowledgeEngineConfig,
  snapshot: string | null
): KnowledgeEngineConfig {
  if (!snapshot) return config
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(snapshot) as Record<string, unknown>
  } catch {
    return config
  }
  const merged = { ...config } as unknown as Record<string, unknown>
  for (const key of INDEX_SNAPSHOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue
    const value = parsed[key]
    if (!isSnapshotValueValid(key, value)) continue
    merged[key] = value
  }
  return merged as unknown as KnowledgeEngineConfig
}

/**
 * 索引口径指纹：以上述 7 项 + 「建索引时向量是否真的可用」为准。
 * 内容没变、配置也没变 → 重建时跳过该文档（省 embedding 调用）。
 */
export function indexSignature(config: KnowledgeEngineConfig, embeddingUsed: boolean): string {
  const parts: string[] = []
  for (const key of SIGNATURE_KEYS) parts.push(`${key}=${String(config[key])}`)
  parts.push(`embeddingUsed=${embeddingUsed ? 1 : 0}`)
  return createHash('sha1').update(parts.join('|')).digest('hex')
}

function isSnapshotValueValid(key: string, value: unknown): boolean {
  switch (key) {
    case 'chunkSize':
      return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 8192
    case 'chunkOverlap':
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 4096
    case 'vectorDimensions':
      return [1024, 1536, 3072].includes(value as number)
    case 'bm25K1':
      return typeof value === 'number' && value >= 0 && value <= 10
    case 'bm25B':
    case 'hybridWeight':
      return typeof value === 'number' && value >= 0 && value <= 1
    case 'topK':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100
    case 'sparseRetrieval':
    case 'rerankEnabled':
    case 'graphEnabled':
      return typeof value === 'boolean'
    case 'chunkStrategy':
      return ['semantic', 'fixed', 'markdown', 'recursive'].includes(value as string)
    case 'embeddingModel':
    case 'rerankModel':
    case 'graphModel':
      return typeof value === 'string' && value.trim().length > 0
    default:
      return false
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback
}
