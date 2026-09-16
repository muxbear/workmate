import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createPinia } from 'pinia'
import KnowledgeUploadModal from '../../../src/renderer/src/components/knowledge/KnowledgeUploadModal.vue'

/**
 * 上传弹窗首屏渲染验证（SSR，无需 jsdom）
 *
 * 只覆盖不依赖交互的首屏：拖入区域、空列表提示、三个上传后处理单选项与
 * 「创建默认索引」的来源说明。自定义索引向导的配置项由 uploadIndex 的单测钉住。
 *
 * 弹窗打开时会向主进程拉取全局设置与按库覆盖，SSR 下没有 window，
 * 这里给最小 window.api 桩；桩返回失败即回落到渲染层默认值。
 */
function stubWindow(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      getAllSettings: async () => ({ success: false }),
      getKbSettings: async () => ({ success: false }),
      setKbSettings: async () => ({ success: false }),
      listModels: async () => ({ success: false }),
      listModelProviders: async () => ({ success: false })
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

async function render(open: boolean): Promise<string> {
  const app = createSSRApp(KnowledgeUploadModal, {
    open,
    library: { id: 'product', name: '产品资料库' }
  })
  app.use(createPinia())
  return renderToString(app)
}

describe('KnowledgeUploadModal（首屏）', () => {
  it('渲染拖入区域、空列表提示与三个上传后处理选项', async () => {
    stubWindow()
    const html = await render(true)
    expect(html).toContain('拖拽文件到此处')
    expect(html).toContain('点击选择文件')
    expect(html).toContain('还没有待上传文件')
    expect(html).toContain('创建默认索引')
    expect(html).toContain('自定义索引')
    expect(html).toContain('只上传文件')
    // 该知识库没有索引配置 → 使用全局索引配置
    expect(html).toContain('全局索引配置')
    expect(html).toContain('确定')
  })

  it('关闭时不渲染内容', async () => {
    stubWindow()
    expect(await render(false)).not.toContain('拖拽文件到此处')
  })
})
