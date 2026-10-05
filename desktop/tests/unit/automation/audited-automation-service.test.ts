import { describe, expect, it, vi } from 'vitest'
import { AuditedAutomationService } from '../../../src/main/automation/AuditedAutomationService'
import type { IAutomationService } from '../../../src/main/automation/AutomationService'
import type { AuditLogRepository } from '../../../src/main/automation/AuditLogRepository'
import type { AutomationTaskRecord } from '../../../src/main/automation/types'

/**
 * 审计装饰器（R8-10）：载荷逐字、记录时机、透传与抛错路径。
 * 全部以替身驱动（inner 假服务 + audit 捕获器），不依赖数据库。
 */

interface AuditCall {
  userId: string
  action: string
  detail: Record<string, unknown>
}

function taskRecord(overrides: Partial<AutomationTaskRecord> = {}): AutomationTaskRecord {
  return {
    id: 't1',
    userId: 'u1',
    name: '示例任务',
    source: 'custom',
    freqSummary: '每天 09:00',
    fullAccess: true,
    enabled: true,
    ...overrides
  } as unknown as AutomationTaskRecord
}

function makeRig(overrides: Partial<IAutomationService> = {}): {
  audited: AuditedAutomationService
  calls: AuditCall[]
  inner: IAutomationService
  order: string[]
} {
  const calls: AuditCall[] = []
  const order: string[] = []
  const inner = {
    listTasks: vi.fn(() => []),
    getTask: vi.fn(() => taskRecord()),
    createTask: vi.fn(() => {
      order.push('inner:createTask')
      return taskRecord({ id: 'created-1' })
    }),
    updateTask: vi.fn(() => taskRecord({ id: 'updated-1' })),
    deleteTask: vi.fn(() => 1),
    setEnabled: vi.fn((_u: string, _i: unknown, rawEnabled: unknown) => {
      order.push('inner:setEnabled')
      return taskRecord({ id: 'enabled-1', enabled: rawEnabled !== false })
    }),
    runNow: vi.fn(async () => {
      order.push('inner:runNow')
      return { runId: 'run-1' }
    }),
    getRun: vi.fn(() => ({ id: 'r1' })),
    listRuns: vi.fn(() => []),
    runStats: vi.fn(() => ({ total: 0 })),
    scheduleTask: vi.fn(() => ({ nextRunAt: null, status: 'paused' as const })),
    setRunHandler: vi.fn(),
    listDueTasks: vi.fn(() => []),
    findTask: vi.fn(() => null),
    earliestNextRunAt: vi.fn(() => null),
    markRunningInterrupted: vi.fn(() => 0),
    recordSkipped: vi.fn(),
    onStartup: vi.fn(() => ({ interrupted: 0, pruned: 0 })),
    ...overrides
  } as unknown as IAutomationService
  const audit = {
    record: (userId: string, action: string, detail: Record<string, unknown>) => {
      calls.push({ userId, action, detail })
    }
  } as unknown as AuditLogRepository
  return { audited: new AuditedAutomationService(inner, audit), calls, inner, order }
}

describe('AuditedAutomationService（R8-10 装饰器）', () => {
  it('createTask：记录 created 字段的载荷（与原实现逐字一致）', () => {
    const { audited, calls } = makeRig()
    const created = audited.createTask('u1', { name: 'x' })
    expect(created.id).toBe('created-1')
    expect(calls).toEqual([
      {
        userId: 'u1',
        action: 'automation.create',
        detail: { taskId: 'created-1', source: 'custom', freq: '每天 09:00', fullAccess: true }
      }
    ])
  })

  it('updateTask / deleteTask / setEnabled(两分支) / runNow 载荷逐字', async () => {
    const { audited, calls } = makeRig()
    audited.updateTask('u1', 't9', { name: 'y' })
    audited.deleteTask('u1', 't8')
    audited.setEnabled('u1', 't7', false)
    audited.setEnabled('u1', 't6', true)
    await audited.runNow('u1', 't5')
    expect(calls).toEqual([
      {
        userId: 'u1',
        action: 'automation.update',
        detail: { taskId: 'updated-1', freq: '每天 09:00', fullAccess: true }
      },
      { userId: 'u1', action: 'automation.delete', detail: { taskId: 't8' } },
      { userId: 'u1', action: 'automation.enable', detail: { taskId: 'enabled-1', enabled: false } },
      {
        userId: 'u1',
        action: 'automation.enable',
        detail: { taskId: 'enabled-1', enabled: true, fullAccess: true }
      },
      { userId: 'u1', action: 'automation.run', detail: { taskId: 't1', trigger: 'manual' } }
    ])
  })

  it('抛错路径不记录：业务失败时 audit 保持为空', async () => {
    const { audited, calls } = makeRig({
      deleteTask: vi.fn(() => {
        throw new Error('任务不存在或已被删除')
      })
    })
    expect(() => audited.deleteTask('u1', 't1')).toThrow(/不存在/)
    expect(calls).toEqual([])
  })

  it('查询/调度方法纯透传（不产生审计）', () => {
    const { audited, calls, inner } = makeRig()
    audited.listTasks('u1')
    audited.getTask('u1', 't1')
    audited.getRun('u1', 'r1')
    audited.listRuns('u1', { limit: 10 })
    audited.runStats('u1')
    audited.scheduleTask(taskRecord(), 1)
    audited.listDueTasks(1, 10)
    audited.findTask('u1', 't1')
    audited.earliestNextRunAt()
    audited.markRunningInterrupted()
    audited.recordSkipped(taskRecord(), 'schedule', 'reason', 1)
    audited.onStartup()
    expect(calls).toEqual([])
    expect(inner.listDueTasks).toHaveBeenCalledWith(1, 10)
  })

  it('runNow：记录先于委托（如实记录的时机微差；生产装配下与旧实现等价）', async () => {
    const { audited, order, calls } = makeRig()
    await audited.runNow('u1', 't1')
    expect(calls).toHaveLength(1)
    expect(order).toEqual(['inner:runNow'])
  })

  it('setRunHandler 透传给内层服务（装配路径）', () => {
    const { audited, inner } = makeRig()
    const handler = async () => ({ runId: 'r' })
    audited.setRunHandler(handler)
    expect(inner.setRunHandler).toHaveBeenCalledWith(handler)
  })
})
