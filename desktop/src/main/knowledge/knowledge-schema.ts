import { isValidSettingsValue, SETTINGS_SCHEMA, type SettingsKey } from '../settings/schema'

/**
 * 知识库「按库覆盖」配置的 key 与校验（主进程为唯一校验权威）
 *
 * 设计约定：
 * - 可覆盖项 **从 SETTINGS_SCHEMA 运行时派生**，不手写第二份清单 —— schema 增删项时自动纳入，
 *   区间/枚举校验直接委托 isValidSettingsValue，杜绝两处漂移。
 * - 「本地存储 / 存放目录」(knowledge.directory) 不参与按库覆盖：它是整个索引库 index.db 的
 *   机器级位置，按知识库区分没有意义。
 * - 短 key 去掉了 `knowledge.` 前缀，落盘后可直接作为未来 knowledge_bases.config 的字段名。
 */

type KnowledgeSettingsKey = Extract<SettingsKey, `knowledge.${string}`>
type StripKnowledgePrefix<K extends string> = K extends `knowledge.${infer Rest}` ? Rest : never

/** 可被单个知识库覆盖的配置项（短 key） */
export type KnowledgeOverrideKey = StripKnowledgePrefix<
  Exclude<KnowledgeSettingsKey, 'knowledge.directory'>
>

/** 某个知识库的覆盖项：**稀疏**，未出现的 key 表示「跟随全局」 */
export type KnowledgeOverrides = Partial<Record<KnowledgeOverrideKey, unknown>>

/** 可覆盖项清单（17 项；顺序稳定，取自 SETTINGS_SCHEMA 的声明顺序） */
export const KNOWLEDGE_OVERRIDE_KEYS: readonly KnowledgeOverrideKey[] = (
  Object.keys(SETTINGS_SCHEMA) as SettingsKey[]
)
  .filter((key) => key.startsWith('knowledge.') && key !== 'knowledge.directory')
  .map((key) => key.slice('knowledge.'.length) as KnowledgeOverrideKey)

/** 短 key 白名单守卫 */
export function isKnowledgeOverrideKey(key: string): key is KnowledgeOverrideKey {
  return (KNOWLEDGE_OVERRIDE_KEYS as readonly string[]).includes(key)
}

/** 短 key → 全局设置 key（唯一拼接点） */
export function toSettingsKey(key: KnowledgeOverrideKey): SettingsKey {
  return `knowledge.${key}` as SettingsKey
}

/** 单值校验：委托 schema.ts 的类型/枚举/区间规则；非法返回 false */
export function isValidKnowledgeOverrideValue(key: KnowledgeOverrideKey, value: unknown): boolean {
  return isValidSettingsValue(toSettingsKey(key), value)
}

/**
 * 读盘用（宽松）：白名单 + 值校验，非法项静默丢弃。
 * 手工改坏的文件不能把脏配置注入运行时。
 *
 * 注意：只遍历白名单、不遍历入参对象，既是稳定顺序，也避免 `__proto__` 这类键触发原型污染。
 */
export function normalizeKnowledgeOverrides(raw: unknown): KnowledgeOverrides {
  const out: KnowledgeOverrides = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const source = raw as Record<string, unknown>
  for (const key of KNOWLEDGE_OVERRIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (!isValidKnowledgeOverrideValue(key, value)) continue
    out[key] = value
  }
  return out
}

/**
 * 写入用（严格）：未知 key / 非法值一律抛错（IPC 会转成 { success: false }），不静默。
 * 错误消息带字段名，便于渲染层直接展示。
 */
export function assertKnowledgeOverrides(raw: unknown): KnowledgeOverrides {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('知识库配置必须为对象')
  }
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!isKnowledgeOverrideKey(key)) {
      throw new Error(`未知的知识库配置项：${key}`)
    }
  }
  const out: KnowledgeOverrides = {}
  for (const key of KNOWLEDGE_OVERRIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (!isValidKnowledgeOverrideValue(key, value)) {
      throw new Error(`「${key}」的值非法：${JSON.stringify(value)}`)
    }
    out[key] = value
  }
  return out
}

/** 对象键污染防护：这些串作为 map 键会改写原型 */
const FORBIDDEN_OBJECT_KEYS = ['__proto__', 'constructor', 'prototype']

const KB_ID_MAX_LENGTH = 128

/** 知识库 ID 守卫（非空、去首尾空格、长度上限、拒绝原型污染键） */
export function assertKbId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('知识库 ID 必须为字符串')
  const id = raw.trim()
  if (!id) throw new Error('知识库 ID 不能为空')
  if (id.length > KB_ID_MAX_LENGTH) throw new Error('知识库 ID 过长')
  if (FORBIDDEN_OBJECT_KEYS.includes(id)) throw new Error(`知识库 ID 非法：${id}`)
  return id
}

/** 知识库 ID 列表守卫（批量读取用；上限 200 条，避免单次 IPC 拉爆） */
const KB_ID_LIST_MAX_LENGTH = 200

export function assertKbIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('kbIds 必须为数组')
  if (raw.length > KB_ID_LIST_MAX_LENGTH) throw new Error('kbIds 数量过多')
  return raw.map((item) => assertKbId(item))
}
