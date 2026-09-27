import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import KbEditDialog from '@/components/knowledgeBase/KbEditDialog.vue'
import type { KB } from '@/types/knowledgeBase'

/**
 * 编辑知识库弹窗（名称 / 描述 / 标签 / 分组）。
 *
 * 要点：
 *
 * 1. **名称与分组走两个接口**（PATCH 改字段、PUT 改归属）——只改名字时不该多发
 *    一次归组请求，反之亦然；
 * 2. **打开时按当前值回填**——弹窗是"改这个库"，上一次的输入不能留到下一次；
 * 3. 名称不能为空（后端也有 name 约束，前端先拦一道，省一次 400）。
 */

const store = vi.hoisted(() => ({
  kbGroups: [] as { id: string; name: string; kbCount: number }[],
  updateKb: vi.fn(),
  assignGroup: vi.fn(),
}))
vi.mock('@/stores/knowledgeBase', () => ({ useKnowledgeBaseStore: () => store }))

// el-dialog / el-button 的真实实现在 jsdom 下会因弹层定位触发递归更新：换成会渲染
// 插槽、会把点击抛出来的桩——表单要能被点到，才测得了"保存"这条路径
const DialogStub = defineComponent({
  name: 'ElDialog',
  template: '<div class="stub-dialog"><slot /><slot name="footer" /></div>',
})

const ButtonStub = defineComponent({
  name: 'ElButton',
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
})

function makeKb(overrides: Partial<KB> = {}): KB {
  return {
    id: 'kb-1', name: '产品手册', description: '老描述', status: 'ready',
    docs: 1, chunks: 1, entities: 0, relations: 0, size: '1 KB',
    updatedAt: '2026-09-26',
    config: {} as KB['config'],
    documents: [], entitiesData: [], relationsData: [],
    tags: ['产品', '技术'],
    visibility: 'private', isOwner: true, ownerName: null,
    groupId: 'g-1',
    ...overrides,
  }
}

function mountDialog(kb = makeKb()) {
  return mount(KbEditDialog, {
    props: { visible: true, kb },
    global: {
      stubs: {
        teleport: true,
        'el-dialog': DialogStub,
        'el-button': ButtonStub,
      },
    },
  })
}

/** footer 里的保存按钮（取消在前、保存在后） */
function saveButton(wrapper: ReturnType<typeof mountDialog>) {
  const footer = wrapper.get('.stub-dialog').findAll('button')
  return footer[footer.length - 1]
}

describe('KbEditDialog · 编辑知识库', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    store.kbGroups = [
      { id: 'g-1', name: '研发', kbCount: 1 },
      { id: 'g-2', name: '市场', kbCount: 0 },
    ]
    store.updateKb.mockResolvedValue(undefined)
    store.assignGroup.mockResolvedValue(undefined)
  })

  it('打开时用当前值回填', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const inputs = wrapper.findAll('input')
    expect((inputs[0].element as HTMLInputElement).value).toBe('产品手册')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('老描述')
    expect((inputs[1].element as HTMLInputElement).value).toBe('产品, 技术')
  })

  it('保存：名称与标签写回，分组没动就不调归组接口', async () => {
    const wrapper = mountDialog()

    await wrapper.find('input').setValue('产品手册（新）')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(store.updateKb).toHaveBeenCalledWith('kb-1', {
      name: '产品手册（新）',
      description: '老描述',
      tags: ['产品', '技术'],
    })
    expect(store.assignGroup).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('改了分组才调归组接口', async () => {
    const wrapper = mountDialog()

    // 分组列表里点「市场」（不归入任何分组在最前，之后是按顺序的分组）
    const groupButtons = wrapper.findAll('.group-pick-item')
    await groupButtons[2].trigger('click')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(store.assignGroup).toHaveBeenCalledWith('kb-1', 'g-2')
  })

  it('名称留空不提交（后端也会拒，先在前端拦住）', async () => {
    const wrapper = mountDialog()

    await wrapper.find('input').setValue('   ')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(store.updateKb).not.toHaveBeenCalled()
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('接口报错时不关弹窗（用户要能改完重试）', async () => {
    store.updateKb.mockRejectedValue(new Error('boom'))
    const wrapper = mountDialog()

    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
