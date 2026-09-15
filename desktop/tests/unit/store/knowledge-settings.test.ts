import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeSettingsStore } from '../../../src/renderer/src/store/knowledgeSettings'
import { useSettingsStore } from '../../../src/renderer/src/store/settings'

/** 内存版知识库配置接口（覆盖项按 kbId 存） */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createMockWindowApi(initial: Record<string, Record<string, unknown>> = {}) {
  const store = new Map(Object.entries(initial))
  const api = {
    getKbSettings: vi.fn(async (kbIds?: string[]) => {
      if (kbIds) {
        const data: Record<string, unknown> = {}
        for (const kbId of kbIds) data[kbId] = store.get(kbId) ?? {}
        return { success: true, data }
      }
      return { success: true, data: Object.fromEntries(store) }
    }),
    setKbSettings: vi.fn(async (kbId: string, overrides: Record<string, unknown>) => {
      if (Object.keys(overrides).length === 0) store.delete(kbId)
      else store.set(kbId, overrides)
      return { success: true, data: overrides }
    })
  }
  return { api, store }
}

describe('useKnowledgeSettingsStore（按知识库覆盖配置）', () => {
  let mock: ReturnType<typeof createMockWindowApi>

  beforeEach(() => {
    setActivePinia(createPinia())
    mock = createMockWindowApi()
    ;(globalThis as Record<string, unknown>).window = { api: mock.api }
  })

  it('load：回填覆盖项并标记已加载', async () => {
    mock = createMockWindowApi({ product: { chunkSize: 1200 } })
    ;(globalThis as Record<string, unknown>).window = { api: mock.api }
    const store = useKnowledgeSettingsStore()
    await store.load(['product'])

    expect(store.overridesFor('product')).toEqual({ chunkSize: 1200 })
    expect(store.hydratedKbIds.product).toBe(true)
    // 未配置的知识库也会被标记（避免弹窗反复请求）
    expect(store.hydratedKbIds.other).toBeUndefined()
  })

  it('未覆盖项跟随全局，覆盖项取覆盖值', () => {
    const settings = useSettingsStore()
    settings.knowledgeChunkSize = 800
    settings.knowledgeTopK = 12

    const store = useKnowledgeSettingsStore()
    store.overridesByKb = { product: { chunkSize: 1200 } }

    const effective = store.effectiveFor('product')
    expect(effective.chunkSize).toBe(1200)
    expect(effective.topK).toBe(12)
    expect(store.isOverridden('product', 'chunkSize')).toBe(true)
    expect(store.isOverridden('product', 'topK')).toBe(false)
  })

  it('全局设置变化：未覆盖项跟着变，覆盖项不变', () => {
    const settings = useSettingsStore()
    settings.knowledgeChunkSize = 800

    const store = useKnowledgeSettingsStore()
    store.overridesByKb = { product: { chunkSize: 1200 } }
    expect(store.effectiveFor('product').chunkSize).toBe(1200)

    settings.knowledgeChunkSize = 400
    expect(store.effectiveFor('product').chunkSize).toBe(1200) // 覆盖项不受影响
    expect(store.effectiveFor('design').chunkSize).toBe(400) // 未覆盖项跟随
  })

  it('假值覆盖不会被全局值吃掉（0 / false）', () => {
    const settings = useSettingsStore()
    settings.knowledgeBm25B = 0.75
    settings.knowledgeRerankEnabled = true

    const store = useKnowledgeSettingsStore()
    store.overridesByKb = { product: { bm25B: 0, rerankEnabled: false } }

    const effective = store.effectiveFor('product')
    expect(effective.bm25B).toBe(0)
    expect(effective.rerankEnabled).toBe(false)
    expect(store.isOverridden('product', 'bm25B')).toBe(true)
  })

  it('ensureLoaded 只请求未加载过的知识库', async () => {
    const store = useKnowledgeSettingsStore()
    await store.ensureLoaded('product')
    await store.ensureLoaded('product')
    expect(mock.api.getKbSettings).toHaveBeenCalledTimes(1)
  })

  it('saveOverrides 成功：以主进程返回值回填缓存', async () => {
    const store = useKnowledgeSettingsStore()
    const ok = await store.saveOverrides('product', { chunkSize: 1200 })
    expect(ok).toBe(true)
    expect(store.overridesFor('product')).toEqual({ chunkSize: 1200 })
    expect(mock.api.setKbSettings).toHaveBeenCalledWith('product', { chunkSize: 1200 })
  })

  it('saveOverrides 传空对象即清除覆盖（恢复全部跟随全局）', async () => {
    const store = useKnowledgeSettingsStore()
    await store.saveOverrides('product', { chunkSize: 1200 })
    await store.saveOverrides('product', {})
    expect(store.overridesFor('product')).toEqual({})
    expect(store.isOverridden('product', 'chunkSize')).toBe(false)
  })

  it('saveOverrides 失败：返回 false 且不污染缓存', async () => {
    mock.api.setKbSettings.mockResolvedValueOnce({
      success: false,
      error: '「chunkSize」的值非法'
    } as never)
    const store = useKnowledgeSettingsStore()
    const ok = await store.saveOverrides('product', { chunkSize: 99999 })

    expect(ok).toBe(false)
    expect(store.lastError).toContain('chunkSize')
    expect(store.overridesFor('product')).toEqual({})
  })

  it('load 失败：记录错误且缓存保持为空', async () => {
    mock.api.getKbSettings.mockResolvedValueOnce({
      success: false,
      error: '未登录，请先登录'
    } as never)
    const store = useKnowledgeSettingsStore()
    const ok = await store.load(['product'])

    expect(ok).toBe(false)
    expect(store.lastError).toContain('未登录')
    expect(store.overridesFor('product')).toEqual({})
  })
})
