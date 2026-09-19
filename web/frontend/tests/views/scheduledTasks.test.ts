import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ScheduledTasksView from '@/views/ScheduledTasksView.vue'
import * as api from '@/services/automationApi'
import type { AutomationRun, AutomationTask } from '@/types/automation'

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
      validFrom: '',
      validFromTime: '00:00',
      validTo: '',
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
    runCount: 3,
    failCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function run(): AutomationRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    trigger: 'schedule',
    status: 'success',
    scheduledAt: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 1200,
    conversationId: null,
    threadId: null,
    outputPreview: '执行完成',
    outputText: '执行完成',
    model: null,
    errorCode: null,
    errorMessage: null,
    artifacts: [],
    tokenUsage: null,
  }
}

function mountView() {
  return mount(ScheduledTasksView, { global: { plugins: [createPinia()] } })
}

describe('ScheduledTasksView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchTasks).mockResolvedValue([task()])
    vi.mocked(api.fetchRuns).mockResolvedValue([run()])
    vi.mocked(api.fetchRunStats).mockResolvedValue({
      total: 4,
      success: 3,
      failed: 1,
      skipped: 0,
      running: 0,
      avgDurationMs: 1500,
    })
    vi.mocked(api.createTask).mockResolvedValue(task({ id: 'task-2' }))
    vi.mocked(api.setTaskEnabled).mockResolvedValue(task({ enabled: false, status: 'paused' }))
  })

  it('渲染我的任务卡与模版卡片', async () => {
    const wrapper = mountView()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('每日摘要')
    expect(text).toContain('每天 08:00')
    expect(text).toContain('长期有效')
    expect(text).toContain('运行 3 次 / 失败 1 次')
    expect(wrapper.findAll('.auto-card--template')).toHaveLength(12)
    expect(text).toContain('每日 AI 新闻推送')
  })

  it('点击模版「添加」按模版来源创建任务', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAll('.auto-card--template')[0].find('button').trigger('click')
    await flushPromises()

    expect(api.createTask).toHaveBeenCalledTimes(1)
    const draft = vi.mocked(api.createTask).mock.calls[0][0]
    expect(draft.source).toBe('template')
    expect(draft.templateId).toBe('1')
    expect(draft.title).toBe('每日 AI 新闻推送')
  })

  it('点击暂停按钮调用 setTaskEnabled', async () => {
    const wrapper = mountView()
    await flushPromises()

    const pauseBtn = wrapper.find('.auto-card .auto-icon-btn[title="暂停"]')
    await pauseBtn.trigger('click')
    await flushPromises()

    expect(api.setTaskEnabled).toHaveBeenCalledWith('task-1', false)
  })

  it('运行记录页签展示执行历史与本周统计', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.findAll('.auto-tab')[1].trigger('click')
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('运行记录')
    expect(text).toContain('成功')
    expect(text).toContain('1.2s')
    expect(text).toContain('本周运行次数')
    expect(text).toContain('75%')
  })
})
