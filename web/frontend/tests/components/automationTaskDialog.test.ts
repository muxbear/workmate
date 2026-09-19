import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import AutomationTaskDialog from '@/components/automation/AutomationTaskDialog.vue'
import * as api from '@/services/automationApi'
import type { AutomationTask } from '@/types/automation'

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

vi.mock('@/services/attachmentApi', () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}))

vi.mock('@/services/expertApi', () => ({ fetchExperts: vi.fn().mockResolvedValue({ items: [] }) }))
vi.mock('@/services/skillApi', () => ({
  fetchSkills: vi.fn().mockResolvedValue({ items: [] }),
}))
vi.mock('@/services/knowledgeBaseApi', () => ({
  fetchKnowledgeBases: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/services/modelApi', () => ({ fetchProviders: vi.fn().mockResolvedValue([]) }))

function task(): AutomationTask {
  return {
    id: 'task-1',
    title: '每日摘要',
    promptText: '汇总今天的重点内容',
    promptParts: [{ type: 'text', text: '汇总今天的重点内容' }],
    icon: '⏰',
    source: 'custom',
    templateId: null,
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
      validFrom: '2026-09-01',
      validFromTime: '00:00',
      validTo: '2026-09-30',
      validToTime: '23:59',
    },
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    validFromTs: null,
    validToTs: null,
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
    enabled: true,
    status: 'enabled',
    nextRunAt: Date.now() + 3600_000,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    failCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('AutomationTaskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.updateTask).mockResolvedValue(task())
    vi.mocked(api.createTask).mockResolvedValue(task())
    vi.mocked(api.fetchRunStats).mockResolvedValue({
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      avgDurationMs: null,
    })
  })

  it('编辑任务时回填名称、执行计划与有效期', async () => {
    const wrapper = mount(AutomationTaskDialog, {
      props: { task: task() },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    const nameInput = wrapper.find('input.atd-input').element as HTMLInputElement
    expect(nameInput.value).toBe('每日摘要')
    expect(wrapper.text()).toContain('执行计划：每天 08:00')
    expect(wrapper.text()).toContain('有效期：长期有效')
  })

  it('切换间隔频率后执行计划文案随之更新', async () => {
    const wrapper = mount(AutomationTaskDialog, {
      props: { task: task() },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    await wrapper.findAll('.atd-seg-btn')[1].trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('每隔 2 小时执行 1 次')
    expect(wrapper.text()).toContain('小时执行 1 次')
  })

  it('保存时按编辑对象提交任务草稿并触发 saved', async () => {
    const wrapper = mount(AutomationTaskDialog, {
      props: { task: task() },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()

    await wrapper.find('.atd-btn--confirm').trigger('click')
    await flushPromises()

    expect(api.updateTask).toHaveBeenCalledTimes(1)
    const [id, draft] = vi.mocked(api.updateTask).mock.calls[0]
    expect(id).toBe('task-1')
    expect(draft.title).toBe('每日摘要')
    expect(draft.promptParts).toEqual([{ type: 'text', text: '汇总今天的重点内容' }])
    expect(draft.schedule.cycleKind).toBe('daily')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })
})
