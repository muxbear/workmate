import type { KnowledgeSettingsStore } from './KnowledgeSettingsStore'
import {
  assertKbId,
  assertKnowledgeOverrides,
  KNOWLEDGE_OVERRIDE_KEYS,
  toSettingsKey,
  type KnowledgeOverrideKey,
  type KnowledgeOverrides
} from './knowledge-schema'

export interface KnowledgeSettingsServiceDeps {
  /** 全局设置快照（SettingsStore.getAll()：默认值已合并，17 项必然有值） */
  getGlobalSettings: () => Record<string, unknown>
}

/** 某知识库的生效配置：全局值被逐项覆盖后的结果 */
export interface KnowledgeEffective {
  effective: Record<KnowledgeOverrideKey, unknown>
  /** 被显式覆盖的项（UI 展示「自定义」标记用） */
  overridden: KnowledgeOverrideKey[]
}

/**
 * 知识库「按库覆盖」配置服务（主进程权威）
 *
 * 语义：**省略 = 跟随全局**。覆盖项以 key 的「存在与否」表达，不看值的真假 ——
 * bm25B: 0 / graphEnabled: false / topK: 1 都是合法覆盖，任何空值回退都会吃掉它们。
 *
 * 与「知识库设置」页的关系：全局值仍由 settings.json 持有；本服务只存各知识库的稀疏覆盖，
 * getEffective() 把两者合成为生效配置，供未来索引/检索管线消费。
 */
export class KnowledgeSettingsService {
  private readonly store: KnowledgeSettingsStore
  private readonly deps: KnowledgeSettingsServiceDeps

  constructor(store: KnowledgeSettingsStore, deps: KnowledgeSettingsServiceDeps) {
    this.store = store
    this.deps = deps
  }

  /** 单库覆盖项（稀疏）；未配置返回 {} */
  getOverrides(userId: string, kbId: string): KnowledgeOverrides {
    const map = this.store.getUserKbMap(assertKbId(userId))
    return map[assertKbId(kbId)] ?? {}
  }

  /**
   * 批量读取覆盖项。
   * 传 kbIds 时按传入顺序逐项返回（未配置的为 {}，便于渲染层标记已加载）；
   * 省略 kbIds 时返回该用户全部已配置项。
   */
  getOverridesBatch(userId: string, kbIds?: string[]): Record<string, KnowledgeOverrides> {
    const map = this.store.getUserKbMap(assertKbId(userId))
    if (!kbIds) return map
    const out: Record<string, KnowledgeOverrides> = {}
    for (const raw of kbIds) {
      const kbId = assertKbId(raw)
      out[kbId] = map[kbId] ?? {}
    }
    return out
  }

  /**
   * 全量替换某知识库的覆盖项（严格校验，非法抛错且不落盘）。
   * 传 {} 即「全部恢复跟随全局」，会删除该库条目。
   */
  setOverrides(userId: string, kbId: string, raw: unknown): KnowledgeOverrides {
    const safeUserId = assertKbId(userId)
    const safeKbId = assertKbId(kbId)
    const overrides = assertKnowledgeOverrides(raw)
    const map = this.store.getUserKbMap(safeUserId)
    map[safeKbId] = overrides
    this.store.setUserKbMap(safeUserId, map)
    return overrides
  }

  /** 生效配置 = 全局值 ← 逐项覆盖（未覆盖项跟随全局当前值） */
  getEffective(userId: string, kbId: string): KnowledgeEffective {
    const global = this.deps.getGlobalSettings()
    const overrides = this.getOverrides(userId, kbId)
    const effective = {} as Record<KnowledgeOverrideKey, unknown>
    const overridden: KnowledgeOverrideKey[] = []
    for (const key of KNOWLEDGE_OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        effective[key] = overrides[key]
        overridden.push(key)
      } else {
        effective[key] = global[toSettingsKey(key)]
      }
    }
    return { effective, overridden }
  }
}
