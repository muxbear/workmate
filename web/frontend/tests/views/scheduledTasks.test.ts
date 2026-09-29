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

  it('渲染我的任务卡，且不再有「自动化任务模版」区域', async () => {
    const wrapper = mountView()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('每日摘要')
    expect(text).toContain('每天 08:00')
    expect(text).toContain('长期有效')
    expect(text).toContain('运行 3 次 / 失败 1 次')
    expect(wrapper.findAll('.auto-card')).toHaveLength(1)

    // 模版已独立成「控制 → 定时模板」页面，本页不该再出现模板块
    expect(text).not.toContain('自动化任务模版')
    expect(wrapper.findAll('.auto-card--template')).toHaveLength(0)
  })

  it('卡片与表格两种形态可以切换，数据同源', async () => {
    const wrapper = mountView()
    await flushPromises()

    // 默认卡片视图
    expect(wrapper.findAll('.auto-card')).toHaveLength(1)
    expect(wrapper.findAll('.auto-table--tasks .auto-table-row')).toHaveLength(0)

    await wrapper.find('.auto-view-toggle button[title="表格视图"]').trigger('click')
    expect(wrapper.findAll('.auto-card')).toHaveLength(0)
    const rows = wrapper.findAll('.auto-table--tasks .auto-table-row')
    expect(rows).toHaveLength(1)
    // 表格里同样能看到任务名与执行计划
    expect(rows[0].text()).toContain('每日摘要')
    expect(rows[0].text()).toContain('每天 08:00')

    await wrapper.find('.auto-view-toggle button[title="卡片视图"]').trigger('click')
    expect(wrapper.findAll('.auto-card')).toHaveLength(1)
    expect(wrapper.findAll('.auto-table--tasks .auto-table-row')).toHaveLength(0)
  })

  it('表格形态下同样能编辑与删除', async () => {
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('.auto-view-toggle button[title="表格视图"]').trigger('click')

    const actions = wrapper.find('.auto-table--tasks .auto-cell-actions')
    expect(actions.find('button[title="编辑"]').exists()).toBe(true)
    expect(actions.find('button[title="删除"]').exists()).toBe(true)
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
