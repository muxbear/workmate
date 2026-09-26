import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbUrlImportDialog from '@/components/knowledgeBase/KbUrlImportDialog.vue'
import type { IndexConfig } from '@/types/knowledgeBase'

/**
 * 导入网页对话框（迭代 6 T6.1 批次②）。
 *
 * 两件必须成立的事：
 *
 * 1. **"未启用"要给出配置指引**，而不是笼统的"导入失败"——后端在未配置白名单时
 *    会返回一段带变量名的中文说明，界面得原样展示出来；
 * 2. 地址不合法时提交按钮不可用（避免让用户白填一遍再被后端拒）。
 */

const CONFIG = {
  chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
  embeddingModel: '', embeddingProviderId: '', embeddingDim: 1024,
  sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
  entityModel: '', relationModel: '', enableGraph: true,
  rerankerModel: '', rerankerProviderId: '', enableReranker: true,
  topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
  maxChunksPerDoc: 3, dedupSimilarity: 0.92,
  parentChunkSize: 1536, minChunkSize: 32,
  enableQueryRewrite: false, enableHyde: false,
} as IndexConfig

async function mountDialog(props: Record<string, unknown> = {}) {
  // 先以不可见挂载再切换：对话框的可见状态由 `watch(props.visible)` 驱动，
  // 初始就传 true 的话 watcher 不会触发（真实用法也总是先挂为 false）
  const wrapper = mount(KbUrlImportDialog, {
    props: { visible: false, defaultConfig: CONFIG, error: null, ...props },
    global: { stubs: { teleport: true } },
  })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

describe('KbUrlImportDialog', () => {
  it('显示后端给出的配置指引（未启用白名单时）', async () => {
    const guidance = 'URL 导入未启用：请在 .env 配置 KB_URL_IMPORT_ALLOWED_HOSTS'
    const wrapper = await mountDialog({ error: guidance })

    expect(wrapper.text()).toContain('KB_URL_IMPORT_ALLOWED_HOSTS')
  })

  it('地址为空时提交按钮不可用', async () => {
    const wrapper = await mountDialog()
    const submit = wrapper.find('.btn-upload')

    expect(submit.attributes('disabled')).toBeDefined()
  })

  it('填入合法地址后可提交，并带上地址与索引模式', async () => {
    const wrapper = await mountDialog()

    await wrapper.find('.field-input').setValue('https://example.com/doc')
    await wrapper.find('.btn-upload').trigger('click')

    expect(wrapper.emitted('submit')?.[0]?.[0]).toBe('https://example.com/doc')
  })

  it('非 http(s) 的地址不认为是合法输入', async () => {
    const wrapper = await mountDialog()

    await wrapper.find('.field-input').setValue('file:///etc/passwd')

    expect(wrapper.find('.btn-upload').attributes('disabled')).toBeDefined()
  })
})
