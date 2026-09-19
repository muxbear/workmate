import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAutomationStore } from '@/stores/automation'
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

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
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
    runCount: 0,
    failCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('automationStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('loadTasks 后计算任务统计与最近唤醒任务', async () => {
    const store = useAutomationStore()
    vi.mocked(api.fetchTasks).mockResolvedValue([
      task({ id: 'a', title: '任务A', nextRunAt: 2000 }),
      task({ id: 'b', title: '任务B', enabled: false, status: 'paused', nextRunAt: null }),
      task({ id: 'c', title: '任务C', nextRunAt: 1000 }),
    ])

    await store.loadTasks()

    expect(store.tasks).toHaveLength(3)
    expect(store.taskStats).toEqual({ total: 3, enabled: 2, paused: 1 })
    expect(store.nextTask?.id).toBe('c')
    expect(store.taskNameById.c).toBe('任务C')
  })

  it('createTask 前插新任务，deleteTask 移除任务', async () => {
    const store = useAutomationStore()
    const created = task({ id: 'new-1', title: '新任务' })
    vi.mocked(api.createTask).mockResolvedValue(created)
    vi.mocked(api.deleteTask).mockResolvedValue(undefined)

    await store.createTask({} as never)
    expect(store.tasks.map((item) => item.id)).toEqual(['new-1'])

    await store.deleteTask('new-1')
    expect(store.tasks).toEqual([])
  })

  it('setEnabled 与 runNow 会同步任务状态', async () => {
    const store = useAutomationStore()
    store.tasks = [task({ id: 'task-1' })]
    vi.mocked(api.setTaskEnabled).mockResolvedValue(
      task({ id: 'task-1', enabled: false, status: 'paused', nextRunAt: null }),
    )
    vi.mocked(api.runTaskNow).mockResolvedValue({ runId: 'run-1' })
    vi.mocked(api.fetchTasks).mockResolvedValue([task({ id: 'task-1' })])

    const paused = await store.setEnabled('task-1', false)
    expect(paused.enabled).toBe(false)
    expect(store.tasks[0].enabled).toBe(false)

    const result = await store.runNow('task-1')
    expect(result.runId).toBe('run-1')
    expect(api.fetchTasks).toHaveBeenCalled()
  })

  it('loadMoreRuns 使用最后一条 startedAt 作为游标', async () => {
    const store = useAutomationStore()
    store.runs = [
      { id: 'r2', startedAt: 200 },
      { id: 'r1', startedAt: 100 },
    ] as never
    vi.mocked(api.fetchRuns).mockResolvedValue([])

    await store.loadMoreRuns(50)

    expect(api.fetchRuns).toHaveBeenCalledWith({ limit: 50, cursor: 100 })
  })

  it('loadStats 失败时写入错误信息且不抛出', async () => {
    const store = useAutomationStore()
    vi.mocked(api.fetchRunStats).mockRejectedValue(new Error('统计失败'))

    await store.loadStats()

    expect(store.stats).toBeNull()
    expect(store.error).toBe('统计失败')
  })
})
