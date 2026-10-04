import { isAbsolute } from 'path'

/**
 * 绯荤粺璁剧疆 Schema 鏉冨▉锛圴S Code 榛樿鍊煎悎骞舵ā寮?+ WorkBuddy 宓屽鍔熻兘鍩熷垎缁勶級
 *
 * 瀛樺偍 key 涓哄祵濂楄矾寰勫瓧绗︿覆锛堝 'ui.language'锛夛紝纾佺洏鏂囦欢涓哄祵濂楀璞★紙瀵归綈 WorkBuddy
 * settings.json 鐨?camelCase 鍩熷垎缁勶細sandbox/claw/enabledPlugins 瀹炴祴锛夛紱涓昏繘绋嬩负鍞竴
 * 鏍￠獙鏉冨▉锛堢櫧鍚嶅崟 + 绫诲瀷 + 鏋氫妇/鏍煎紡/鍖洪棿锛夛紝娓叉煋灞備笉鍙俊銆? */

export type ApplyTiming = 'instant' | 'pending'

export type SettingsKey =
  | 'ui.language'
  | 'ui.fontSize'
  | 'ui.theme'
  | 'ui.systemName'
  | 'ui.brandLogo'
  | 'skills.autoUpdate'
  | 'skills.safeInstall'
  | 'lockScreen.remoteLock'
  | 'network.proxyMode'
  | 'network.proxyUrl'
  | 'workspace.defaultWorkspaceDir'
  | 'notification.clientNotifications'
  | 'notification.sound'
  | 'runtime.enabled'
  | 'runtime.python.enabled'
  | 'runtime.node.enabled'
  | 'runtime.git.enabled'
  | 'knowledge.directory'
  | 'knowledge.maxUploadSize'
  | 'knowledge.uploadTimeout'
  | 'knowledge.maxFilesPerBatch'
  | 'knowledge.chunkStrategy'
  | 'knowledge.chunkSize'
  | 'knowledge.chunkOverlap'
  | 'knowledge.vectorDimensions'
  | 'knowledge.embeddingModel'
  | 'knowledge.sparseRetrieval'
  | 'knowledge.bm25K1'
  | 'knowledge.bm25B'
  | 'knowledge.hybridWeight'
  | 'knowledge.rerankEnabled'
  | 'knowledge.rerankModel'
  | 'knowledge.topK'
  | 'knowledge.graphEnabled'
  | 'knowledge.graphModel'
  | 'knowledge.embeddingBaseUrl'
  | 'knowledge.embeddingApiKey'
  | 'knowledge.rerankBaseUrl'
  | 'knowledge.rerankApiKey'
  | 'knowledge.minSimilarity'
  | 'knowledge.queryRewriteEnabled'
  | 'knowledge.mmrEnabled'
  | 'knowledge.mmrLambda'
  | 'knowledge.timeDecayHalfLifeDays'

export interface SettingsSchemaEntry {
  type: 'string' | 'number' | 'boolean'
  default: unknown
  /** 鐢熸晥鏃舵満锛歩nstant=淇濆瓨鍗崇敓鏁堬紱pending=鍔熻兘鏃犺惤鐐逛粎鎸佷箙鍖栵紙UI 鏄惧紡鏍囨敞"鍚庣画鐗堟湰鐢熸晥"锛?*/
  applyTiming: ApplyTiming
  /** 鏋氫妇/鏍煎紡/鍖洪棿鏍￠獙锛堥潪娉曞€煎洖閫€榛樿锛?*/
  validate?: (v: unknown) => boolean
}

const LANGUAGE_OPTIONS = ['zh-CN', 'zh-TW', 'en']
const THEME_OPTIONS = ['light', 'dark']
const PROXY_MODES = ['direct', 'system', 'manual']
const SOUND_OPTIONS = ['none', 'crisp', 'soft']

/** 系统名称（品牌名）默认值与长度上限（「系统设置 → 系统标识」） */
export const DEFAULT_SYSTEM_NAME = 'Ke-Work'
export const SYSTEM_NAME_MAX_LENGTH = 24
/** 自定义 LOGO 文件名（存放于 ~/.ke-work/branding/；空串 = 使用内置默认 LOGO） */
export const BRAND_LOGO_FILE_RE = /^logo-\d+\.(png|jpe?g|webp|svg)$/

/**
 * 系统名称校验：trim 后非空、不超过上限、不含换行/制表/控制字符。
 * 主进程为校验权威，渲染层只做即时提示。
 */
export function isValidSystemName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (!name || name.length > SYSTEM_NAME_MAX_LENGTH) return false
  // 控制字符（含换行/制表）会破坏窗口标题与单行展示，按码点逐字符拒绝
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** 知识库：切片算法 / 向量维度枚举（对齐设置页下拉项） */
const CHUNK_STRATEGIES = ['semantic', 'fixed', 'markdown', 'recursive']
const VECTOR_DIMENSIONS = [1024, 1536, 3072]

/** http(s)://host[:port][/path] 鏍煎紡锛堜唬鐞嗗湴鍧€蹇呭～鏍￠獙锛?*/
const PROXY_URL_RE = /^https?:\/\/[^:\s/]+(:\d{1,5})?(\/.*)?$/

export const SETTINGS_SCHEMA: Record<SettingsKey, SettingsSchemaEntry> = {
  'ui.language': {
    type: 'string',
    default: 'zh-CN',
    applyTiming: 'instant',
    validate: (v) => LANGUAGE_OPTIONS.includes(v as string)
  },
  'ui.fontSize': {
    type: 'number',
    default: 17,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 12 && (v as number) <= 24
  },
  'ui.theme': {
    type: 'string',
    default: 'light',
    applyTiming: 'instant',
    validate: (v) => THEME_OPTIONS.includes(v as string)
  },
  'ui.systemName': {
    type: 'string',
    default: DEFAULT_SYSTEM_NAME,
    applyTiming: 'instant',
    validate: (v) => isValidSystemName(v)
  },
  'ui.brandLogo': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || BRAND_LOGO_FILE_RE.test(v))
  },
  'skills.autoUpdate': { type: 'boolean', default: true, applyTiming: 'pending' },
  'skills.safeInstall': { type: 'boolean', default: false, applyTiming: 'pending' },
  'lockScreen.remoteLock': { type: 'boolean', default: false, applyTiming: 'instant' },
  'network.proxyMode': {
    type: 'string',
    default: 'direct',
    applyTiming: 'instant',
    validate: (v) => PROXY_MODES.includes(v as string)
  },
  'network.proxyUrl': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || PROXY_URL_RE.test(v))
  },
  'workspace.defaultWorkspaceDir': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || isAbsolute(v))
  },
  'notification.clientNotifications': { type: 'boolean', default: true, applyTiming: 'pending' },
  'notification.sound': {
    type: 'string',
    default: 'none',
    applyTiming: 'pending',
    validate: (v) => SOUND_OPTIONS.includes(v as string)
  },
  'runtime.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.python.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.node.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'runtime.git.enabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  // ── 知识库配置（设置窗口「知识库设置」页；空目录 = 回退 meta.defaultKnowledgeDir） ──
  'knowledge.directory': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || isAbsolute(v))
  },
  'knowledge.maxUploadSize': {
    type: 'number',
    default: 100,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10240
  },
  'knowledge.uploadTimeout': {
    type: 'number',
    default: 10,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 600
  },
  'knowledge.maxFilesPerBatch': {
    type: 'number',
    default: 20,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000
  },
  'knowledge.chunkStrategy': {
    type: 'string',
    default: 'semantic',
    applyTiming: 'instant',
    validate: (v) => CHUNK_STRATEGIES.includes(v as string)
  },
  'knowledge.chunkSize': {
    type: 'number',
    default: 800,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 8192
  },
  'knowledge.chunkOverlap': {
    type: 'number',
    default: 120,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4096
  },
  'knowledge.vectorDimensions': {
    type: 'number',
    default: 1024,
    applyTiming: 'instant',
    validate: (v) => VECTOR_DIMENSIONS.includes(v as number)
  },
  'knowledge.embeddingModel': {
    type: 'string',
    default: 'text-embedding-3-large',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && v.trim().length > 0
  },
  'knowledge.sparseRetrieval': { type: 'boolean', default: true, applyTiming: 'instant' },
  'knowledge.bm25K1': {
    type: 'number',
    default: 1.5,
    applyTiming: 'instant',
    validate: (v) => (v as number) >= 0 && (v as number) <= 10
  },
  'knowledge.bm25B': {
    type: 'number',
    default: 0.75,
    applyTiming: 'instant',
    validate: (v) => (v as number) >= 0 && (v as number) <= 1
  },
  'knowledge.hybridWeight': {
    type: 'number',
    default: 0.65,
    applyTiming: 'instant',
    validate: (v) => (v as number) >= 0 && (v as number) <= 1
  },
  'knowledge.rerankEnabled': { type: 'boolean', default: true, applyTiming: 'instant' },
  'knowledge.rerankModel': {
    type: 'string',
    default: 'bge-reranker-v2-m3',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && v.trim().length > 0
  },
  'knowledge.topK': {
    type: 'number',
    default: 12,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100
  },
  'knowledge.graphEnabled': { type: 'boolean', default: false, applyTiming: 'instant' },
  'knowledge.graphModel': {
    type: 'string',
    default: 'GLM-5',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && v.trim().length > 0
  },
  // ── 嵌入与重排端点（RAG 向量化 / 重排的凭据；全局一份，不参与按库覆盖）──
  // 留空 = 未启用向量化：索引走纯稀疏链路，检索降级为关键词检索（UI 会提示）。
  'knowledge.embeddingBaseUrl': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || /^https?:\/\/\S+$/.test(v))
  },
  'knowledge.embeddingApiKey': {
    type: 'string',
    default: '',
    applyTiming: 'instant'
  },
  'knowledge.rerankBaseUrl': {
    type: 'string',
    default: '',
    applyTiming: 'instant',
    validate: (v) => typeof v === 'string' && (v === '' || /^https?:\/\/\S+$/.test(v))
  },
  'knowledge.rerankApiKey': {
    type: 'string',
    default: '',
    applyTiming: 'instant'
  },
  // 稠密检索相似度门限（0 = 关闭）：低于门限视为「没有相关内容」，问答不编造
  'knowledge.minSimilarity': {
    type: 'number',
    default: 0.53,
    applyTiming: 'instant',
    validate: (v) => (v as number) >= 0 && (v as number) <= 1
  },
  // 查询改写（Hybrid RAG 的 query enhancement）：默认关闭，开启后每次检索多一次模型调用
  'knowledge.queryRewriteEnabled': { type: 'boolean', default: false, applyTiming: 'instant' },
  // ── P7 增强层（均为检索期参数：不进索引快照、不影响索引指纹）──
  // MMR 去冗余：对融合后的候选按「相关度 vs 与已选项的冗余度」贪心重选，压掉近重复切片
  'knowledge.mmrEnabled': { type: 'boolean', default: false, applyTiming: 'instant' },
  // MMR 相关度权重 λ：越大越偏相关度、越小越偏多样性
  'knowledge.mmrLambda': {
    type: 'number',
    default: 0.7,
    applyTiming: 'instant',
    validate: (v) => (v as number) >= 0 && (v as number) <= 1
  },
  // 时间衰减半衰期（天，0 = 关闭）：按文档导入时间对最终分数做 0.5^(年龄/半衰期) 加权
  'knowledge.timeDecayHalfLifeDays': {
    type: 'number',
    default: 0,
    applyTiming: 'instant',
    validate: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3650
  }
}

/** settings.json 椤跺眰缁撴瀯鐗堟湰锛堝榻?WorkBuddy workspace-state.json 鐨?version 瀛楁锛?*/
export const SETTINGS_VERSION = 1

/** 鐧藉悕鍗曞畧鍗?*/
export function isSettingsKey(k: string): k is SettingsKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, k)
}

/** 鍗曞€煎畬鏁存牎楠岋紙鐧藉悕鍗?+ 绫诲瀷 + 鏋氫妇/鏍煎紡/鍖洪棿锛夛紱闈炴硶杩斿洖 false */
export function isValidSettingsValue(key: SettingsKey, value: unknown): boolean {
  const entry = SETTINGS_SCHEMA[key]
  if (!entry) return false
  if (!isValidValue(entry, value)) return false
  if (entry.validate && !entry.validate(value)) return false
  return true
}

/** 鍏ㄩ粯璁ゅ€硷紙鎵佸钩 key 鏄犲皠锛?*/
export function defaultSettings(): Record<SettingsKey, unknown> {
  const out = {} as Record<SettingsKey, unknown>
  for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
    out[key as SettingsKey] = entry.default
  }
  return out
}

function isValidValue(entry: SettingsSchemaEntry, value: unknown): boolean {
  switch (entry.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
  }
}

/** 宓屽瀵硅薄鎷嶅钩锛歿"ui":{"language":"zh-CN"}} 鈫?{"ui.language":"zh-CN"} */
export function flattenSettings(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenSettings(value as Record<string, unknown>, path))
    } else {
      out[path] = value
    }
  }
  return out
}

/** 扁平 key 映射还原为嵌套对象（persist 写盘用，对齐 WorkBuddy 嵌套域格式） */
export function unflattenSettings(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (typeof node[part] !== 'object' || node[part] === null) {
        node[part] = {}
      }
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

/**
 * 默认值合并（VS Code 模式）：默认值 ∪ 文件内值，逐字段类型/枚举校验，非法值回退默认。
 * 输入为磁盘嵌套对象（含 version 等非设置字段会被 flatten 后忽略）。
 */
export function normalizeSettings(raw: Record<string, unknown>): Record<SettingsKey, unknown> {
  const flat = flattenSettings(raw)
  const out = defaultSettings()
  for (const [key, entry] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in flat)) continue
    const value = flat[key]
    if (!isValidValue(entry, value)) continue
    if (entry.validate && !entry.validate(value)) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  return out
}

/** 需要路由到安全存储（secrets.bin）而非明文写 settings.json 的键（SettingsStore 消费） */
export const SECRET_SETTINGS_KEYS: readonly SettingsKey[] = [
  'knowledge.embeddingApiKey',
  'knowledge.rerankApiKey'
]
