import { ref } from 'vue'

/** 内置的已知模型类型（用于配色/图标的默认值） */
export type KnownModelType =
  | 'llm'
  | 'vision'
  | 'audio'
  | 'video'
  | 'embedding'
  | 'image-gen'
  | 'speech'
  | 'multimodal'
  | 'rerank'

/**
 * 模型类型。
 *
 * 可选值由「参数配置」页面的 `model_type` 分组下发，管理员可增删改任意编码，
 * 因此这里保留已知类型的自动补全，同时允许任意字符串（`string & {}`）。
 */
export type ModelType = KnownModelType | (string & {})

/** 「参数配置」页面下发的模型类型选项 */
export interface ModelTypeOption {
  value: string
  label: string
}

/** 模型状态 */
export type ModelStatus = 'active' | 'beta' | 'deprecated' | 'inactive'

/** 提供商连接状态 */
export type ProviderStatus = 'connected' | 'error' | 'unconfigured'

/** 模型参数 */
export interface ModelParam {
  key: string
  label: string
  value: number | string
  min?: number
  max?: number
  step?: number
  type: 'number' | 'text' | 'select'
  options?: string[]
}

/** AI 模型实体 */
export interface AIModel {
  id: string
  name: string
  displayName: string
  type: ModelType
  status: ModelStatus
  contextWindow?: number
  /** 最大输入长度（tokens，单次提示上限） */
  maxInputTokens?: number
  /** 最大输出长度（tokens，生成上限） */
  maxOutputTokens?: number
  /** 向量维度（仅 embedding 模型有意义）；留空时后端首次调用会探测并落库 */
  dim?: number
  /** 每分钟请求数上限 */
  rpm?: number
  /** 每分钟 token 上限 */
  tpm?: number
  /** 模型级 API 地址覆盖；为空时继承提供商的 apiBase */
  apiBase?: string
  callCount: number
  params: ModelParam[]
  description: string
  releaseDate?: string
  sortOrder?: number
  /** 是否为全局默认对话模型（全局唯一，由「设为默认」按钮设置） */
  isDefault: boolean
}

/** 模型提供商 */
export interface Provider {
  id: string
  name: string
  logo: string
  status: ProviderStatus
  apiBase: string
  responseUrl: string
  anthropicUrl: string
  apiKey: string
  models: AIModel[]
  description: string
  website: string
  sortOrder?: number
}

/** 模型类型元数据（配色/图标） */
export interface ModelTypeMeta {
  label: string
  color: string
  bg: string
  border: string
  emoji: string
}

/** 内置类型的配色与图标；展示名会被「参数配置」下发的标签覆盖 */
export const MODEL_TYPE_META: Record<KnownModelType, ModelTypeMeta> = {
  llm: {
    label: '大语言模型',
    color: '#a5b4fc',
    bg: 'rgba(99,102,241,0.1)',
    border: 'rgba(99,102,241,0.25)',
    emoji: '💬',
  },
  vision: {
    label: '视觉模型',
    color: '#c4b5fd',
    bg: 'rgba(139,92,246,0.1)',
    border: 'rgba(139,92,246,0.25)',
    emoji: '👁️',
  },
  audio: {
    label: '音频模型',
    color: '#6ee7b7',
    bg: 'rgba(16,185,129,0.1)',
    border: 'rgba(16,185,129,0.25)',
    emoji: '🎵',
  },
  video: {
    label: '视频模型',
    color: '#f472b6',
    bg: 'rgba(236,72,153,0.1)',
    border: 'rgba(236,72,153,0.25)',
    emoji: '🎬',
  },
  embedding: {
    label: '向量模型',
    color: '#67e8f9',
    bg: 'rgba(6,182,212,0.1)',
    border: 'rgba(6,182,212,0.25)',
    emoji: '🔢',
  },
  'image-gen': {
    label: '图像生成',
    color: '#fbbf24',
    bg: 'rgba(245,158,11,0.1)',
    border: 'rgba(245,158,11,0.25)',
    emoji: '🎨',
  },
  speech: {
    label: '语音合成',
    color: '#5eead4',
    bg: 'rgba(20,184,166,0.1)',
    border: 'rgba(20,184,166,0.25)',
    emoji: '🗣️',
  },
  multimodal: {
    label: '多模态',
    color: '#fdba74',
    bg: 'rgba(251,146,60,0.1)',
    border: 'rgba(251,146,60,0.25)',
    emoji: '🧠',
  },
  rerank: {
    label: '重排序模型',
    color: '#fca5a5',
    bg: 'rgba(239,68,68,0.1)',
    border: 'rgba(239,68,68,0.25)',
    emoji: '📊',
  },
}

/** 未登记类型的兜底样式——保证管理员自定义类型不会让界面取到 undefined */
const FALLBACK_TYPE_META: ModelTypeMeta = {
  label: '未知类型',
  color: '#cbd5e1',
  bg: 'rgba(148,163,184,0.1)',
  border: 'rgba(148,163,184,0.25)',
  emoji: '🧩',
}

/**
 * 「参数配置」下发的类型标签（覆盖内置展示名）。
 *
 * 用 ref 而非普通 Map：模板里大量通过 getModelTypeMeta() 取标签，若容器不是
 * 响应式的，标签晚于模型列表到达时界面不会刷新。
 */
const runtimeTypeLabels = ref<Record<string, string>>({})

/**
 * 记录「参数配置」下发的模型类型选项。
 *
 * 只需登记标签：配色与图标仍按内置表取，未登记的类型走兜底样式。
 */
export function registerModelTypeOptions(options: ModelTypeOption[]): void {
  const next: Record<string, string> = {}
  for (const option of options) {
    if (option?.value) next[option.value] = option.label || option.value
  }
  runtimeTypeLabels.value = next
}

/**
 * 安全取模型类型元数据。
 *
 * 类型可选值来自「参数配置」，因此 `MODEL_TYPE_META[type]` 这种直接索引在
 * 管理员新增类型时会返回 undefined 并在模板里崩掉（`.bg` of undefined）。
 * 所有需要展示类型标签/配色的地方都应改用本函数。
 */
export function getModelTypeMeta(type: string | undefined | null): ModelTypeMeta {
  const code = (type || '').trim()
  const builtin = code ? (MODEL_TYPE_META as Record<string, ModelTypeMeta>)[code] : undefined
  const label = code ? runtimeTypeLabels.value[code] : undefined

  if (builtin) return label ? { ...builtin, label } : builtin
  return { ...FALLBACK_TYPE_META, label: label || code || FALLBACK_TYPE_META.label }
}

/** 提供商状态元数据 */
export const PROVIDER_STATUS_META: Record<
  ProviderStatus,
  { label: string; color: string; dot: string }
> = {
  connected: { label: '已连接', color: '#6ee7b7', dot: '#10B981' },
  error: { label: '连接异常', color: '#f87171', dot: '#EF4444' },
  unconfigured: { label: '未配置', color: '#6b7280', dot: '#4B5563' },
}

/** 模型状态元数据 */
export const MODEL_STATUS_META: Record<ModelStatus, { label: string; color: string; bg: string }> =
  {
    active: {
      label: '正常',
      color: '#6ee7b7',
      bg: 'rgba(16,185,129,0.1) border: 1px solid rgba(16,185,129,0.2)',
    },
    beta: {
      label: 'Beta',
      color: '#fbbf24',
      bg: 'rgba(245,158,11,0.1) border: 1px solid rgba(245,158,11,0.2)',
    },
    deprecated: {
      label: '已弃用',
      color: '#6b7280',
      bg: 'rgba(75,85,99,0.2) border: 1px solid rgba(75,85,99,0.3)',
    },
    inactive: {
      label: '已禁用',
      color: '#f87171',
      bg: 'rgba(239,68,68,0.1) border: 1px solid rgba(239,68,68,0.2)',
    },
  }
