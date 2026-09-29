import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { useScheduleTemplateStore } from '@/stores/scheduleTemplate'
import ScheduleTemplatesView from '@/views/ScheduleTemplatesView.vue'
import ScheduleTemplateDialog from '@/components/automation/ScheduleTemplateDialog.vue'
import * as api from '@/services/scheduleTemplateApi'
import * as taskApi from '@/services/automationApi'
import { toTaskDraft } from '@/types/scheduleTemplate'
import type { ScheduleTemplate } from '@/types/scheduleTemplate'
import type { AutomationTask } from '@/types/automation'

vi.mock('@/services/scheduleTemplateApi', () => ({
  fetchTemplates: vi.fn(),
  fetchTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  fetchTemplateTypes: vi.fn(),
}))

// 「添加到定时任务」要读当前用户的任务列表（判断哪些模板已添加）
vi.mock('@/services/automationApi', () => ({
  fetchTasks: vi.fn(),
  fetchTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  setTaskEnabled: vi.fn(),
  runTaskNow: vi.fn(),
  fetchRuns: vi.fn(),
  fetchRun: vi.fn(),
  fetchRunStats: vi.fn(),
}))

// 弹窗还会去拉模型/专家/技能/知识库，这里只关心模板本身
vi.mock('@/services/modelApi', () => ({ fetchProviders: vi.fn().mockResolvedValue([]) }))
vi.mock('@/services/expertApi', () => ({
  fetchExperts: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
}))
vi.mock('@/services/skillApi', () => ({
  fetchSkills: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 }),
}))
vi.mock('@/services/knowledgeBaseApi', () => ({ fetchKnowledgeBases: vi.fn().mockResolvedValue([]) }))

function template(overrides: Partial<ScheduleTemplate> = {}): ScheduleTemplate {
  return {
    id: 'tpl-1',
    name: '每日行业简报',
    description: '汇总当天行业动态',
    icon: '📰',
    category: 'news',
    version: '1.3.0',
    promptText: '请汇总今天的行业重点动态',
    promptParts: [{ type: 'text', text: '请汇总今天的行业重点动态' }],
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '08:00',
      weekDays: [1],
      monthDay: 1,
      yearMonth: 1,
      yearDay: 1,
      weekIntervalDays: [1],
      hourInterval: 2,
      validityMode: 'forever',
      validFrom: '',
      validFromTime: '00:00',
      validTo: '',
      validToTime: '23:59',
    },
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    model: null,
    customModelId: null,
    providerId: null,
    modelId: null,
    expertId: null,
    expertName: null,
    contextMode: 'default',
    skillIds: [],
    kbIds: [],
    workspaceId: null,
    workspaceName: null,
    allowNetwork: false,
    allowShell: false,
    fullAccess: false,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const TYPES = [
  { value: 'news', label: '资讯推送' },
  { value: 'work', label: '工作提效' },
]

function mountView() {
  return mount(ScheduleTemplatesView, {
    global: { plugins: [createPinia()], stubs: { ScheduleTemplateDialog: true } },
  })
}

describe('ScheduleTemplatesView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(api.fetchTemplateTypes).mockResolvedValue(TYPES)
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      items: [template()],
      total: 1,
      page: 1,
      page_size: 12,
    })
    vi.mocked(taskApi.fetchTasks).mockResolvedValue([])
  })

  it('加载时同时取类型与模板列表，卡片视图展示版本与类型名', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(api.fetchTemplateTypes).toHaveBeenCalled()
    expect(api.fetchTemplates).toHaveBeenCalledWith({
      page: 1,
      pageSize: 12,
      keyword: '',
      category: '',
    })

    const text = wrapper.text()
    expect(text).toContain('每日行业简报')
    expect(text).toContain('每天 08:00')
    // 版本号与类型中文名（类型来自参数配置）
    expect(text).toContain('v1.3.0')
    expect(text).toContain('资讯推送')

    expect(wrapper.findAll('.tpl-card')).toHaveLength(1)
    expect(wrapper.findAll('.tpl-table-row')).toHaveLength(0)
  })

  it('卡片 / 表格可以切换，两种形态用同一份分页数据', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.tpl-toggle button:nth-child(2)').trigger('click')
    expect(wrapper.findAll('.tpl-table-row')).toHaveLength(1)
    expect(wrapper.findAll('.tpl-card')).toHaveLength(0)
    expect(wrapper.text()).toContain('执行计划')

    await wrapper.find('.tpl-toggle button:nth-child(1)').trigger('click')
    expect(wrapper.findAll('.tpl-card')).toHaveLength(1)
    expect(wrapper.findAll('.tpl-table-row')).toHaveLength(0)
  })

  it('点击类型 chip 按类型筛选并回到第一页', async () => {
    const wrapper = mountView()
    await flushPromises()

    const workChip = wrapper
      .findAll('.tpl-chip')
      .find((chip) => chip.text() === '工作提效')
    expect(workChip).toBeTruthy()
    await workChip!.trigger('click')
    await flushPromises()

    expect(api.fetchTemplates).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 12,
      keyword: '',
      category: 'work',
    })
  })

  it('未配置类型时筛选区只剩「全部」', async () => {
    vi.mocked(api.fetchTemplateTypes).mockResolvedValue([])
    const wrapper = mountView()
    await flushPromises()

    const chips = wrapper.findAll('.tpl-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].text()).toBe('全部')
  })

  it('删除要先确认；确认后调删除接口并刷新列表', async () => {
    vi.mocked(api.deleteTemplate).mockResolvedValue(undefined)
    const confirmSpy = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockResolvedValue('confirm' as never)
    const wrapper = mountView()
    await flushPromises()
    vi.mocked(api.fetchTemplates).mockClear()

    await wrapper.find('.tpl-icon-btn--danger').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalled()
    expect(api.deleteTemplate).toHaveBeenCalledWith('tpl-1')
    expect(api.fetchTemplates).toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('取消确认框时不删除', async () => {
    vi.mocked(api.deleteTemplate).mockResolvedValue(undefined)
    const confirmSpy = vi
      .spyOn(ElMessageBox, 'confirm')
      .mockRejectedValue(new Error('cancel'))
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.tpl-icon-btn--danger').trigger('click')
    await flushPromises()

    expect(api.deleteTemplate).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('卡片上可以把模板添加到定时任务，按钮随即置为「已添加」', async () => {
    vi.mocked(taskApi.createTask).mockResolvedValue({ id: 'task-new', templateId: 'tpl-1' } as AutomationTask)
    const wrapper = mountView()
    await flushPromises()

    const addBtn = wrapper.find('.tpl-card .tpl-add-btn')
    expect(addBtn.text()).toContain('添加到定时任务')
    expect(addBtn.attributes('disabled')).toBeUndefined()

    await addBtn.trigger('click')
    await flushPromises()

    expect(taskApi.createTask).toHaveBeenCalledTimes(1)
    const draft = vi.mocked(taskApi.createTask).mock.calls[0][0]
    expect(draft.source).toBe('template')
    expect(draft.templateId).toBe('tpl-1')
    expect(draft.title).toBe('每日行业简报')
    expect(draft.promptText).toBe('请汇总今天的行业重点动态')

    // 添加成功后按钮置灰，避免重复添加
    const after = wrapper.find('.tpl-card .tpl-add-btn')
    expect(after.text()).toContain('已添加')
    expect(after.attributes('disabled')).toBeDefined()
  })

  it('表格形态下也能添加，且已添加的模板初始就是置灰的', async () => {
    // 用户已经有一个由该模板生成的任务
    vi.mocked(taskApi.fetchTasks).mockResolvedValue([
      { id: 'task-1', templateId: 'tpl-1' } as AutomationTask,
    ])
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('.tpl-toggle button:nth-child(2)').trigger('click')
    const addBtn = wrapper.find('.tpl-table-row .tpl-add-btn')
    expect(addBtn.text()).toContain('已添加')
    expect(addBtn.attributes('disabled')).toBeDefined()
  })

  it('store 层不去重：同一模板可再建一个任务（只有按钮置灰防连点）', async () => {
    vi.mocked(taskApi.createTask).mockResolvedValue({ id: 'task-new' } as AutomationTask)
    const store = useScheduleTemplateStore()

    await store.addToTasks(template())
    await store.addToTasks(template())

    expect(taskApi.createTask).toHaveBeenCalledTimes(2)
  })

  it('toTaskDraft 把「单次」模板的占位日期换成当天', async () => {
    const once = template({
      schedule: {
        ...template().schedule,
        cycleKind: 'once',
        onceDate: '2020-01-01',
      },
    })
    const draft = toTaskDraft(once)
    const today = new Date()
    const expected = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    expect(draft.schedule.onceDate).toBe(expected)
  })

  it('编辑弹窗默认把版本预填为「次版本 +1」', async () => {
    const wrapper = mountView()
    await flushPromises()

    // 直接用弹窗组件验证版本默认值（页面的对话框已 stub）
    const dialog = mount(ScheduleTemplateDialog, {
      props: { template: template({ version: '1.3.0' }) },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    const versionInput = dialog
      .findAll('input')
      .find((input) => (input.element as HTMLInputElement).value === '1.4.0')
    expect(versionInput).toBeTruthy()
    expect(dialog.text()).toContain('1.3.0 → 1.4.0')

    wrapper.unmount()
  })

  it('新建弹窗版本从 1.0.0 起步', async () => {
    const dialog = mount(ScheduleTemplateDialog, {
      props: { template: null },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    const versionInput = dialog
      .findAll('input')
      .find((input) => (input.element as HTMLInputElement).value === '1.0.0')
    expect(versionInput).toBeTruthy()
    expect(dialog.text()).toContain('新建模板默认从 1.0.0 开始')
  })
})
