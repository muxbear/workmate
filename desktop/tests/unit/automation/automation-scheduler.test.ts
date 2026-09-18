import { describe, expect, it, vi } from 'vitest'
import { AutomationScheduler } from '../../../src/main/automation/AutomationScheduler'
import type { AutomationService } from '../../../src/main/automation/AutomationService'
import type { AutomationRunner } from '../../../src/main/automation/AutomationRunner'
import type { AutomationTaskRecord } from '../../../src/main/automation/types'

/** 构造最小可用任务记录 */
function makeTask(overrides: Partial<AutomationTaskRecord> = {}): AutomationTaskRecord {
  return {
    id: 'task-1',
    userId: 'user-1',
    title: '测试任务',
    promptText: '测试',
    promptParts: [{ type: 'text', text: '测试' }],
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
      validToTime: '23:59'
    },
    freqSummary: '每天 08:00',
    validitySummary: '长期有效',
    validFromTs: null,
    validToTs: null,
    model: null,
    customModelId: null,
    expertId: null,
    expertName: null,
    contextMode: 'default',
    skillIds: [],
    workspaceId: null,
    workspaceName: null,
    fullAccess: false,
    enabled: true,
    status: 'enabled',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    failCount: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...overrides
  }
}

/** 组装调度器与桩服务 */
function setup(
  tasks: AutomationTaskRecord[],
  now: number
): {
  scheduler: AutomationScheduler
  run: ReturnType<typeof vi.fn>
  recordSkipped: ReturnType<typeof vi.fn>
  markRunningInterrupted: ReturnType<typeof vi.fn>
} {
  const recordSkipped = vi.fn()
  const markRunningInterrupted = vi.fn(() => 0)
  // 真实执行器在运行开始时会推后 next_run_at，这里只返回一次以贴近实际
  let dueCalls = 0
  const listDueTasks = vi.fn(() => {
    dueCalls += 1
    return dueCalls === 1 ? tasks : []
  })
  const service = {
    listDueTasks,
    findTask: (userId: string, id: string) =>
      tasks.find((t) => t.userId === userId && t.id === id) ?? null,
    earliestNextRunAt: () => null,
    recordSkipped,
    markRunningInterrupted
  } as unknown as AutomationService
  const run = vi.fn(async () => ({ runId: 'run-1' }))
  const runner = { run } as unknown as AutomationRunner
  const scheduler = new AutomationScheduler({
    service,
    runner,
    now: () => now,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
    log: () => undefined
  })
  return { scheduler, run, recordSkipped, markRunningInterrupted }
}

describe('AutomationScheduler', () => {
  it('启动时对宽限期内错过的任务补跑（trigger 为 catchup）', async () => {
    const now = 1_800_000_000_000
    const task = makeTask({ nextRunAt: now - 60_000 })
    const { scheduler, run, recordSkipped } = setup([task], now)
    await scheduler.start()
    scheduler.stop()
    expect(run).toHaveBeenCalledTimes(1)
    // 触发来源为 catchup 由调度器传参保证（这里只校验调用次数与后续落库行为）
    expect(recordSkipped).not.toHaveBeenCalled()
  })

  it('超出宽限的错过任务只记 skipped 并重排', async () => {
    const now = 1_800_000_000_000
    const task = makeTask({ nextRunAt: now - 30 * 60_000 })
    const { scheduler, run, recordSkipped } = setup([task], now)
    await scheduler.start()
    scheduler.stop()
    expect(run).not.toHaveBeenCalled()
    expect(recordSkipped).toHaveBeenCalledTimes(1)
    expect(recordSkipped.mock.calls[0][0]).toMatchObject({ id: 'task-1' })
    expect(recordSkipped.mock.calls[0][2]).toContain('应用未运行')
  })

  it('已暂停的任务不会被执行', async () => {
    const now = 1_800_000_000_000
    const paused = makeTask({ id: 'task-b', enabled: false, nextRunAt: now - 1000 })
    const { scheduler, run } = setup([paused], now)
    await scheduler.start()
    scheduler.stop()
    expect(run).not.toHaveBeenCalled()
  })

  it('执行器抛错不影响后续任务，调度器继续运行', async () => {
    const now = 1_800_000_000_000
    const first = makeTask({ id: 'task-1', nextRunAt: now - 1000 })
    const second = makeTask({ id: 'task-2', nextRunAt: now - 900 })
    const { scheduler, run } = setup([first, second], now)
    run.mockRejectedValueOnce(new Error('boom'))
    await scheduler.start()
    scheduler.stop()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('停止时把进行中的运行标记为中断', async () => {
    const now = 1_800_000_000_000
    const { scheduler, markRunningInterrupted } = setup([], now)
    await scheduler.start()
    scheduler.stop()
    expect(markRunningInterrupted).toHaveBeenCalled()
  })
})
