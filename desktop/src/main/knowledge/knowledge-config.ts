import { createHash } from 'crypto'
import type { KnowledgeOverrideKey } from './knowledge-schema'
import type { KnowledgeChunkStrategy } from './types'

/** 全局独占（不参与按库覆盖）的知识库配置项（短 key） */
type GlobalOnlyKey = 'embeddingBaseUrl' | 'embeddingApiKey' | 'rerankBaseUrl' | 'rerankApiKey'

/** 四种切片策略（收值与快照校验共用） */
const CHUNK_STRATEGIES = ['semantic', 'fixed', 'markdown', 'recursive'] as const

/**
 * 配置三层来源（全局 ← 按库覆盖 → 上传快照）的合并已由
 * `KnowledgeSettingsService.getEffective()` 完成；本模块只负责：
 * 1. 把 `Record<key, unknown>` 收成引擎直接可用的类型（容错：越界/缺失回退默认）；
 * 2. 生成**上传快照**（14 个索引项）与**索引口径指纹**（配置变了才需要重建）。
 *
 * 历史问题：快照键清单 / 指纹键清单 / 默认值 / 收值逻辑 / 快照校验是五份手工并行的清单，
 * 新增配置项要改五处、漏一处即静默失效。现已全部收敛到下方 `OVERRIDE_FIELDS` 注册表派生。
 */

/**
 * 「按库可覆盖」配置项注册表 —— 五份清单的唯一来源。
 *
 * - **顺序即序列**：INDEX_SNAPSHOT_KEYS / SIGNATURE_KEYS 按此声明顺序派生；指纹 sha1
 *   对参与项顺序敏感，调整顺序必须通过 `knowledge-config-signature.test.ts` 红线测试；
 * - `satisfies Record<KnowledgeOverrideKey, …>`：KnowledgeOverrideKey 增删而此处漏配即编译错误；
 * - `fallback` 是默认值的唯一副本；`coerce` 是收值口径的唯一副本
 *   （越界回退/钳制语义与历史逐字段一致，见 coerceField）；
 * - 上传限制项（maxUploadSize 等 3 项）由 KnowledgeFileService 消费、不属于引擎视图，
 *   以 `scope: 'upload'` 占位登记（保证 Registry 对 22 项覆盖完整，但不进默认值/快照/指纹）。
 */
type OverrideField =
  | {
      scope: 'engine'
      fallback: string | number | boolean
      coerce:
        | 'str'
        | 'bool'
        | 'num'
        | 'positiveInt'
        | 'nonNegativeInt'
        | 'clamp01'
        | 'chunkStrategy'
      /** 进入上传快照（pickIndexSnapshot / normalizeIndexSnapshot / overlaySnapshot） */
      inSnapshot: boolean
      /** 参与索引口径指纹（indexSignature；检索侧参数不参与：改 topK 不需要重建索引） */
      inSignature: boolean
      /** 快照值合法性校验（仅快照项；normalize 对非法值抛错，overlay 跳过非法项） */
      validateSnapshot?: (value: unknown) => boolean
    }
  /** 上传限制项：引擎视图不含它，仅登记以完成 22 项穷举 */
  | { scope: 'upload' }

const OVERRIDE_FIELDS = {
  chunkStrategy: {
    scope: 'engine',
    fallback: 'recursive',
    coerce: 'chunkStrategy',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => CHUNK_STRATEGIES.includes(v as KnowledgeChunkStrategy)
  },
  chunkSize: {
    scope: 'engine',
    fallback: 800,
    coerce: 'positiveInt',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 8192
  },
  chunkOverlap: {
    scope: 'engine',
    fallback: 120,
    coerce: 'nonNegativeInt',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4096
  },
  embeddingModel: {
    scope: 'engine',
    fallback: '',
    coerce: 'str',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => typeof v === 'string' && v.trim().length > 0
  },
  vectorDimensions: {
    scope: 'engine',
    fallback: 1024,
    coerce: 'positiveInt',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => [1024, 1536, 3072].includes(v as number)
  },
  sparseRetrieval: {
    scope: 'engine',
    fallback: true,
    coerce: 'bool',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'boolean'
  },
  bm25K1: {
    scope: 'engine',
    fallback: 1.5,
    coerce: 'num',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'number' && v >= 0 && v <= 10
  },
  bm25B: {
    scope: 'engine',
    fallback: 0.75,
    coerce: 'num',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'number' && v >= 0 && v <= 1
  },
  hybridWeight: {
    scope: 'engine',
    fallback: 0.65,
    coerce: 'num',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'number' && v >= 0 && v <= 1
  },
  rerankEnabled: {
    scope: 'engine',
    fallback: false,
    coerce: 'bool',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'boolean'
  },
  rerankModel: {
    scope: 'engine',
    fallback: '',
    coerce: 'str',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => typeof v === 'string' && v.trim().length > 0
  },
  topK: {
    scope: 'engine',
    fallback: 12,
    coerce: 'positiveInt',
    inSnapshot: true,
    inSignature: false,
    validateSnapshot: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100
  },
  minSimilarity: { scope: 'engine', fallback: 0.53, coerce: 'clamp01', inSnapshot: false, inSignature: false },
  queryRewriteEnabled: { scope: 'engine', fallback: false, coerce: 'bool', inSnapshot: false, inSignature: false },
  mmrEnabled: { scope: 'engine', fallback: false, coerce: 'bool', inSnapshot: false, inSignature: false },
  mmrLambda: { scope: 'engine', fallback: 0.7, coerce: 'clamp01', inSnapshot: false, inSignature: false },
  timeDecayHalfLifeDays: {
    scope: 'engine',
    fallback: 0,
    coerce: 'nonNegativeInt',
    inSnapshot: false,
    inSignature: false
  },
  graphEnabled: {
    scope: 'engine',
    fallback: false,
    coerce: 'bool',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => typeof v === 'boolean'
  },
  graphModel: {
    scope: 'engine',
    fallback: '',
    coerce: 'str',
    inSnapshot: true,
    inSignature: true,
    validateSnapshot: (v) => typeof v === 'string' && v.trim().length > 0
  },
  // ── 上传限制项（KnowledgeFileService 消费；不进引擎视图/快照/指纹）──
  maxUploadSize: { scope: 'upload' },
  uploadTimeout: { scope: 'upload' },
  maxFilesPerBatch: { scope: 'upload' }
} satisfies Record<KnowledgeOverrideKey, OverrideField>

/** 全部按库覆盖项（短 key，声明顺序） */
const OVERRIDE_KEYS = Object.keys(OVERRIDE_FIELDS) as KnowledgeOverrideKey[]

/** 取引擎项的注册信息（上传限制项无引擎语义，调用方仅对引擎项使用） */
function engineField(key: KnowledgeOverrideKey): Extract<OverrideField, { scope: 'engine' }> {
  const field = OVERRIDE_FIELDS[key]
  if (field.scope !== 'engine') throw new Error(`配置项 ${key} 不是引擎项`)
  return field
}

/** 引擎项清单（顺序即快照/指纹的序列来源） */
const ENGINE_KEYS: readonly KnowledgeOverrideKey[] = OVERRIDE_KEYS.filter(
  (key) => OVERRIDE_FIELDS[key].scope === 'engine'
)

/** 上传快照包含的项（与渲染层 uploadIndex.ts 的 INDEX_FIELD_KEYS 对应；顺序被红线测试钉死） */
export const INDEX_SNAPSHOT_KEYS: readonly KnowledgeOverrideKey[] = ENGINE_KEYS.filter(
  (key) => engineField(key).inSnapshot
)

/** 影响「索引产物」的配置项（指纹参与项；sha1 对顺序敏感，勿调整） */
const SIGNATURE_KEYS: readonly KnowledgeOverrideKey[] = ENGINE_KEYS.filter(
  (key) => engineField(key).inSignature
)

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

/** 引擎默认值：引擎项取自注册表，全局端点项显式给出 */
function buildFallback(): KnowledgeEngineConfig {
  const base: Record<string, unknown> = {
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    rerankBaseUrl: '',
    rerankApiKey: ''
  }
  for (const key of ENGINE_KEYS) base[key] = engineField(key).fallback
  return base as unknown as KnowledgeEngineConfig
}

/**
 * 把生效配置收成强类型。
 *
 * - `effective`：`getEffective().effective`（19 项按库可覆盖的短 key）；
 * - `global`：全局设置快照（补 4 个端点 key —— 它们不参与按库覆盖）。
 */
export function toEngineConfig(
  effective: Record<string, unknown>,
  global: Record<string, unknown>
): KnowledgeEngineConfig {
  const config = buildFallback()
  const target = config as unknown as Record<string, unknown>
  for (const key of ENGINE_KEYS) {
    const field = engineField(key)
    const raw = effective[key]
    target[key] = raw === undefined ? field.fallback : coerceField(key, raw)
  }
  /** 全局独占项（不进按库覆盖）：直接用 settings key 读全局快照 */
  const readGlobal = (key: GlobalOnlyKey): unknown => global[`knowledge.${key}`]
  config.embeddingBaseUrl = str(readGlobal('embeddingBaseUrl')).trim()
  config.embeddingApiKey = str(readGlobal('embeddingApiKey'))
  config.rerankBaseUrl = str(readGlobal('rerankBaseUrl')).trim()
  config.rerankApiKey = str(readGlobal('rerankApiKey'))
  return config
}

/** 按注册表的 coerce 类型收值（越界回退/钳制口径与历史实现逐字段一致） */
function coerceField(key: KnowledgeOverrideKey, raw: unknown): string | number | boolean {
  const field = engineField(key)
  switch (field.coerce) {
    case 'str':
      return str(raw)
    case 'bool':
      return bool(raw, field.fallback as boolean)
    case 'num':
      return num(raw, field.fallback as number)
    case 'positiveInt':
      return positiveInt(raw, field.fallback as number)
    case 'nonNegativeInt':
      return nonNegativeInt(raw, field.fallback as number)
    case 'clamp01':
      return clamp01(num(raw, field.fallback as number))
    case 'chunkStrategy':
      return CHUNK_STRATEGIES.includes(raw as KnowledgeChunkStrategy)
        ? (raw as KnowledgeChunkStrategy)
        : (field.fallback as KnowledgeChunkStrategy)
    default:
      throw new Error(`未知收值类型：${(field as { coerce?: string }).coerce ?? 'undefined'}`)
  }
}

/** 上传快照：只取快照项（JSON 字符串直接落 `knowledge_base_documents.config`） */
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

/** 快照值校验：查注册表（非快照项/未知 key 一律不合法，与历史 default:false 口径一致） */
function isSnapshotValueValid(key: string, value: unknown): boolean {
  const field = (OVERRIDE_FIELDS as Record<string, OverrideField | undefined>)[key]
  if (!field || field.scope !== 'engine' || !field.validateSnapshot) return false
  return field.validateSnapshot(value)
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
