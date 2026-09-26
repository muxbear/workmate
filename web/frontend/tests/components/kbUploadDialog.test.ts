import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KbUploadDialog from '@/components/knowledgeBase/KbUploadDialog.vue'
import type { IndexConfig } from '@/types/knowledgeBase'

/**
 * 上传对话框（迭代 6 T6.1 批次③）：文件夹上传、逐文件进度、失败重试。
 *
 * 三条来自实际使用的不变式：
 *
 * 1. **超限文件要出现在清单里并说明原因**——此前的实现是静默 `continue`，
 *    用户以为传了、其实没传，这类"没报错但没生效"最难查；
 * 2. **上传过程在对话框内可见**：逐文件进度与终态（已入队 / 已跳过 / 失败原因）；
 * 3. **可以只重试失败项**——跳过是去重的正常结果，不该被重试（重试还是跳过）。
 */

const uploadDocs = vi.hoisted(() => vi.fn())
vi.mock('@/stores/knowledgeBase', () => ({
  useKnowledgeBaseStore: () => ({ uploadDocs }),

}))

const CONFIG = {
  chunkStrategy: 'recursive', chunkSize: 512, chunkOverlap: 64,
  embeddingModel: '', embeddingProviderId: '', embeddingDim: 1024,
  sparseAlgo: 'bm25', bm25K1: 1.5, bm25B: 0.75,
  entityModel: '', relationModel: '', enableGraph: true,
  rerankerModel: '', rerankerProviderId: '', enableReranker: true,
  topK: 10, hybridAlpha: 0.5, minSimilarity: 0.53, scoreThreshold: 0,
  maxChunksPerDoc: 3, dedupSimilarity: 0.92,
  enableOcr: false, ocrModel: '', ocrProviderId: '',
  parentChunkSize: 1536, minChunkSize: 32,
  enableQueryRewrite: false, enableHyde: false,
} as IndexConfig

async function mountDialog() {
  const wrapper = mount(KbUploadDialog, {
    props: { visible: false, defaultConfig: CONFIG, kbId: 'kb-1' },
    global: { stubs: { teleport: true } },
  })
  await wrapper.setProps({ visible: true })
  await flushPromises()
  return wrapper
}

/** jsdom 里 input.files 是只读的，直接定义属性来模拟用户选文件 */
async function pickFiles(wrapper: ReturnType<typeof mount>, files: File[]) {
  const input = wrapper.findAll('input[type=file]')[0]
  Object.defineProperty(input.element, 'files', { value: files, writable: false })
  await input.trigger('change')
  await flushPromises()
}

function file(name: string, size = 10): File {
  const f = new File(['内容'], name, { type: 'text/markdown' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  uploadDocs.mockResolvedValue({ created: 0, skipped: [], failed: [] })
})

describe('KbUploadDialog · 文件选择', () => {
  it('提供整目录上传的入口（webkitdirectory）', async () => {
    const wrapper = await mountDialog()

    const inputs = wrapper.findAll('input[type=file]')
    expect(inputs.length).toBe(2)
    expect(inputs[1].attributes('webkitdirectory')).toBeDefined()
    expect(wrapper.text()).toContain('选择文件夹')
  })

  it('超限文件进入清单并说明"不会上传"，而不是静默丢弃', async () => {
    const wrapper = await mountDialog()

    await pickFiles(wrapper, [file('正常.md'), file('巨大.pdf', 200 * 1024 * 1024)])

    expect(wrapper.text()).toContain('巨大.pdf')
    expect(wrapper.text()).toContain('不会上传')
    // 只有可上传的那个计入开始按钮
    expect(wrapper.find('.btn-upload').text()).toContain('开始索引 (1)')
  })

  it('目录上传时展示相对路径', async () => {
    const wrapper = await mountDialog()
    const nested = file('a.md')
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'docs/子目录/a.md' })

    await pickFiles(wrapper, [nested])

    expect(wrapper.text()).toContain('docs/子目录/a.md')
  })
})

describe('KbUploadDialog · 上传与重试', () => {
  it('逐文件状态回填，结束后给出汇总', async () => {
    uploadDocs.mockImplementation(async (_kb: string, _files: File[], _cfg: unknown, hooks: { onFileState?: (s: unknown) => void }) => {
      hooks.onFileState?.({ name: 'a.md', status: 'uploading', percent: 55 })
      hooks.onFileState?.({ name: 'a.md', status: 'done', percent: 100 })
      return { created: 1, skipped: [], failed: [] }
    })
    const wrapper = await mountDialog()
    await pickFiles(wrapper, [file('a.md')])

    await wrapper.find('.btn-upload').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('上传完成')
    expect(wrapper.text()).toContain('成功 1')
    expect(wrapper.text()).toContain('已入队')
  })

  it('跳过项显示"已跳过（重复于哪一篇）"', async () => {
    uploadDocs.mockImplementation(async (_kb: string, _files: File[], _cfg: unknown, hooks: { onFileState?: (s: unknown) => void }) => {
      hooks.onFileState?.({
        name: 'a.md', status: 'skipped', percent: 100,
        message: '与《旧版.md》内容相同',
      })
      return { created: 0, skipped: [{ name: 'a.md', reason: 'duplicate' }], failed: [] }
    })
    const wrapper = await mountDialog()
    await pickFiles(wrapper, [file('a.md')])

    await wrapper.find('.btn-upload').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已跳过')
    expect(wrapper.text()).toContain('旧版.md')
  })

  it('有失败项时可"重试失败项"，且只重发失败的那个', async () => {
    let round = 0
    uploadDocs.mockImplementation(async (_kb: string, files: File[], _cfg: unknown, hooks: { onFileState?: (s: unknown) => void }) => {
      round += 1
      const target = files[0]
      if (round === 1) {
        hooks.onFileState?.({ name: target.name, status: 'failed', percent: 0, message: '网络中断' })
        return { created: 0, skipped: [], failed: [{ name: target.name, message: '网络中断' }] }
      }
      hooks.onFileState?.({ name: target.name, status: 'done', percent: 100 })
      return { created: 1, skipped: [], failed: [] }
    })
    const wrapper = await mountDialog()
    await pickFiles(wrapper, [file('a.md'), file('b.md')])

    await wrapper.find('.btn-upload').trigger('click')
    await flushPromises()

    const retry = wrapper.findAll('button').find((b) => b.text().includes('重试失败项'))!
    expect(retry.text()).toContain('(1)')
    await retry.trigger('click')
    await flushPromises()

    expect(uploadDocs).toHaveBeenCalledTimes(2)
    expect(uploadDocs.mock.calls[1][1].map((f: File) => f.name)).toEqual(['a.md'])
  })
})
