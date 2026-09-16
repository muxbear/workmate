import type { KnowledgeOverrideKey, KnowledgeOverrides } from '../../../../preload/index.d'
import { KNOWLEDGE_FIELD_DEFS, KNOWLEDGE_FIELD_LIST } from './knowledgeFields'

/**
 * 「上传文件」弹窗的处理方式与「自定义索引」向导定义
 *
 * 索引项直接由 components/knowledge/knowledgeFields.ts 的字段表派生
 * （索引项 = 全部配置项 - 上传相关 3 项），因此向导里的可配置项与「知识库设置」
 * 页的索引项永远一致，两边不会漂移。
 */

/** 上传后处理方式：三选一 */
export type KnowledgeUploadMode = 'default' | 'custom' | 'none'

export interface KnowledgeUploadOption {
  value: KnowledgeUploadMode
  label: string
  description: string
}

/** 三个单选项（数组顺序即界面顺序） */
export const KNOWLEDGE_UPLOAD_OPTIONS: readonly KnowledgeUploadOption[] = [
  {
    value: 'default',
    label: '创建默认索引',
    description: '按该知识库当前的索引配置建立索引；该库没有索引配置时使用全局索引配置。'
  },
  {
    value: 'custom',
    label: '自定义索引',
    description: '进入索引配置向导，逐步调整本次上传要使用的索引参数。'
  },
  {
    value: 'none',
    label: '只上传文件',
    description: '只保存文件、不建立索引，之后可以再单独为它创建索引。'
  }
]

/** 上传相关配置项：它们属于「文件上传」卡片，不是索引项，不进入向导 */
export const UPLOAD_FIELD_KEYS: readonly KnowledgeOverrideKey[] = [
  'maxUploadSize',
  'uploadTimeout',
  'maxFilesPerBatch'
]

/** 索引项清单（14 项）：可配置项里除上传项之外的全部 */
export const INDEX_FIELD_KEYS: readonly KnowledgeOverrideKey[] = KNOWLEDGE_FIELD_LIST.map(
  (field) => field.key
).filter((key) => !UPLOAD_FIELD_KEYS.includes(key))

export interface KnowledgeIndexStep {
  title: string
  description: string
  keys: readonly KnowledgeOverrideKey[]
}

/** 自定义索引向导的步骤：每一步只放同一类索引项 */
export const KNOWLEDGE_INDEX_STEPS: readonly KnowledgeIndexStep[] = [
  {
    title: '切片策略',
    description: '决定文档被拆分成多长的片段。片段越小检索越精确，越大保留的上下文越多。',
    keys: ['chunkStrategy', 'chunkSize', 'chunkOverlap']
  },
  {
    title: '向量化',
    description: '决定用哪个模型把片段转成向量，以及向量的维度。',
    keys: ['embeddingModel', 'vectorDimensions']
  },
  {
    title: '混合检索与重排',
    description: '结合向量语义与 BM25 关键词检索，再由重排模型优化最终上下文。',
    keys: [
      'sparseRetrieval',
      'bm25K1',
      'bm25B',
      'hybridWeight',
      'rerankEnabled',
      'rerankModel',
      'topK'
    ]
  },
  {
    title: '知识图谱抽取',
    description: '从文档中抽取实体、关系与属性，用于多跳关联问答。',
    keys: ['graphEnabled', 'graphModel']
  }
]

export interface KnowledgeUploadPayload {
  /** 本次要上传的文件（渲染层只持 File 对象，字节暂不落盘） */
  files: File[]
  mode: KnowledgeUploadMode
  /** 本次上传的索引配置快照（只含索引项；只上传文件时为空对象） */
  config: KnowledgeOverrides
  /** 配置来源文案（用于上传结果提示） */
  sourceLabel: string
}

/** 单个配置项的显示文案（布尔 → 开启/关闭；枚举 → 选项名；数值 → 值 + 单位） */
export function formatIndexValue(key: KnowledgeOverrideKey, value: unknown): string {
  const field = KNOWLEDGE_FIELD_DEFS[key]
  if (!field) return value == null ? '未设置' : String(value)
  if (field.kind === 'boolean') return value === true ? '开启' : '关闭'
  const option = field.options?.find((item) => String(item.value) === String(value))
  if (option) return option.label
  if (value == null || value === '') return '未设置'
  return field.unit ? `${value} ${field.unit}` : String(value)
}

/** 索引项摘要（「创建默认索引」时预览将使用的配置） */
export function summarizeIndexConfig(
  config: KnowledgeOverrides
): Array<{ key: KnowledgeOverrideKey; label: string; text: string }> {
  return INDEX_FIELD_KEYS.map((key) => ({
    key,
    label: KNOWLEDGE_FIELD_DEFS[key].label,
    text: formatIndexValue(key, config[key])
  }))
}

/** 从生效配置里裁出索引项（上传时跟着文件一起落库的配置快照） */
export function pickIndexConfig(values: KnowledgeOverrides): KnowledgeOverrides {
  const out: KnowledgeOverrides = {}
  for (const key of INDEX_FIELD_KEYS) out[key] = values[key]
  return out
}

/** 上传结果提示（三种处理方式各自的文案） */
export function uploadResultText(
  mode: KnowledgeUploadMode,
  count: number,
  sourceLabel: string
): string {
  if (mode === 'none') return `已上传 ${count} 个文件，未建立索引`
  if (mode === 'custom') return `已上传 ${count} 个文件，将按自定义索引配置建立索引`
  return `已上传 ${count} 个文件，将按${sourceLabel}建立索引`
}
