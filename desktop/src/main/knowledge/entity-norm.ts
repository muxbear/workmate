/**
 * 实体归一——受控词表与归一键（唯一事实来源）。
 *
 * 与 web 后端 `api/knowledge_base/entity_norm.py` 逐条对齐：
 * - **8 类受控词表**：人物 / 组织 / 产品 / 概念 / 算法 / 地点 / 时间 / 事件。
 *   提示词白名单、落库、前端展示都从这里取，杜绝「三处各写一份」的漂移
 *   （web 那边踩过：提示词 12 类 / 文档 8 类 / 前端 5 类）。
 * - **只做确定性折叠**（去首尾空白 + 折叠内部空白 + 小写），不做同义/别名合并：
 *   模糊合并一旦误合就会**静默丢信息**，需要人工确认回路才谈得上。
 * - **刻意不做全半角折叠**：中文全角括号（`短期记忆（状态）`）本来就该保留原样。
 *
 * 归一键必须与落库、检索侧匹配使用同一函数，否则同一实体会「永远合并不了」且不报错。
 */

/** 受控词表（8 类） */
export const ENTITY_TYPES = ['人物', '组织', '产品', '概念', '算法', '地点', '时间', '事件'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/** 旧 12 类 → 8 类映射（具体的软件产物归「产品」，抽象方法归「概念」） */
export const LEGACY_TYPE_MAP: Record<string, EntityType> = {
  框架: '产品',
  模型: '产品',
  数据集: '产品',
  技术: '概念'
}

/** 兜底类型（与 web 保持一致） */
export const DEFAULT_ENTITY_TYPE: EntityType = '概念'

/**
 * 归一键：`lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))` 的 JS 等价实现。
 * 顺序要紧：先折叠空白再去首尾（`" ".join(s.split())` 语义）。
 */
export function normalizeName(name: string): string {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** 类型收窄：命中受控词表直接用；命中旧词表按映射折叠；其余回退「概念」 */
export function canonicalType(raw: unknown): EntityType {
  const text = String(raw ?? '').trim()
  if ((ENTITY_TYPES as readonly string[]).includes(text)) return text as EntityType
  if (text in LEGACY_TYPE_MAP) return LEGACY_TYPE_MAP[text]
  return DEFAULT_ENTITY_TYPE
}

/** 是否为受控类型（提示词/落库前的硬校验用） */
export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)
}
