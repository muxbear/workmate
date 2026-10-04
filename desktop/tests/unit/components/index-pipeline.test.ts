import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia, setActivePinia } from 'pinia'
import KnowledgeIndexPipeline from '../../../src/renderer/src/components/knowledge/KnowledgeIndexPipeline.vue'
import { useKnowledgeStore } from '../../../src/renderer/src/store/knowledge'
import type { KnowledgeDocumentMeta } from '../../../src/preload/index.d'

/**
 * 索引进度流水线面板的渲染验证（SSR，无需 jsdom）
 *
 * 数据源是 store（knowledge:import-progress 事件在 store 侧打补丁），
 * 这里直接种入文档行、断言七阶段视图：done/running/failed 状态与总进度、指标。
 * 阶段解析语义本身由 index-stages.test.ts 覆盖。
 */

function makeDoc(overrides: Partial<KnowledgeDocumentMeta> = {}): KnowledgeDocumentMeta {
  return {
    id: 'doc-1',
    kbId: 'kb-1',
    name: 'rag.md',
    type: 'md',
    sizeBytes: 204800,
    relPath: 'notes/rag.md',
    indexState: 'default',
    status: 'indexing',
    errorMessage: null,
    progress: 15,
    stage: 'chunking',
    charCount: 12000,
    truncated: false,
    chunksCount: 42,
    entitiesCount: 0,
    relationsCount: 0,
    graphError: null,
    indexedAt: null,
    uploadedAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

async function render(docs: KnowledgeDocumentMeta[]): Promise<string> {
  // 种子与组件必须共用同一个 pinia 实例（组件内 useKnowledgeStore 读 app 上挂的实例）
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useKnowledgeStore()
  store.documentsByKb = { 'kb-1': docs }
  const app = createSSRApp(KnowledgeIndexPipeline, { kbId: 'kb-1', relPath: 'notes/rag.md' })
  app.use(pinia)
  return renderToString(app)
}

describe('KnowledgeIndexPipeline 索引进度面板', () => {
  it('IP-01: 运行中——总进度、指标与 done/running 阶段状态', async () => {
    const html = await render([makeDoc()])
    expect(html).toContain('总进度')
    expect(html).toContain('15%')
    expect(html).toContain('200 KB · notes/rag.md')
    expect(html).toContain('kb-pipe-stage--running')
    expect(html).toContain('切片')
    // 前两个阶段已完成（排队/解析）
    expect(html.match(/kb-pipe-stage--done/g)?.length).toBe(2)
    // 指标：分片 42
    expect(html).toContain('>42<')
  })

  it('IP-02: 已索引——全部 done，无 running/pending', async () => {
    const html = await render([
      makeDoc({ status: 'indexed', stage: 'indexed', progress: 100, entitiesCount: 10, relationsCount: 8 })
    ])
    expect(html).toContain('100%')
    expect(html.match(/kb-pipe-stage--done/g)?.length).toBe(7)
    expect(html).not.toContain('kb-pipe-stage--running')
    expect(html).not.toContain('kb-pipe-stage--pending')
  })

  it('IP-03: 失败——中断阶段标红', async () => {
    const html = await render([
      makeDoc({ status: 'failed', stage: 'embedding', progress: 30, errorMessage: '向量化失败' })
    ])
    expect(html).toContain('kb-pipe-stage--failed')
    expect(html).toContain('向量化')
  })

  it('IP-04: 图谱失败提示（文档仍已索引）', async () => {
    const html = await render([
      makeDoc({ status: 'indexed', stage: 'indexed', progress: 100, graphError: '模型超时' })
    ])
    expect(html).toContain('图谱未生成：模型超时')
  })

  it('IP-05: 文档不存在（已删除）给出空态', async () => {
    const html = await render([])
    expect(html).toContain('文档不存在或已删除')
  })
})
