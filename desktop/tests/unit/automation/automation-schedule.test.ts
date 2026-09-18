import { describe, expect, it } from 'vitest'
import {
  buildFreqSummary,
  buildValiditySummary,
  computeNextRun,
  normalizeWeekDays,
  validityBounds
} from '../../../src/main/automation/AutomationSchedule'
import type { TaskSchedule } from '../../../src/main/automation/types'

/** 构造测试用频率配置（默认每天 08:00） */
function makeSchedule(overrides: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
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
    ...overrides
  }
}

/** 本地时间戳（测试内联，避免依赖被测代码） */
function localTs(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('normalizeWeekDays', () => {
  it('去重、排序并过滤非法值', () => {
    expect(normalizeWeekDays([3, 1, 3, 0, 8, 7])).toEqual([1, 3, 7])
  })

  it('空数组返回空', () => {
    expect(normalizeWeekDays([])).toEqual([])
  })
})

describe('computeNextRun - 周期', () => {
  it('每天：当天时间未到取当天，已过顺延到次日', () => {
    const before = localTs(2026, 9, 18, 7, 0)
    expect(computeNextRun(makeSchedule(), { from: before }).nextRunAt).toBe(
      localTs(2026, 9, 18, 8, 0)
    )
    const after = localTs(2026, 9, 18, 9, 0)
    expect(computeNextRun(makeSchedule(), { from: after }).nextRunAt).toBe(
      localTs(2026, 9, 19, 8, 0)
    )
  })

  it('每周：多选星期取最近的下一个命中日', () => {
    // 2026-09-18 是周五，配置周一与周三，下一次应为 9-21（周一）
    const schedule = makeSchedule({ cycleKind: 'weekly', weekDays: [1, 3], onceTime: '09:30' })
    const from = localTs(2026, 9, 18, 12, 0)
    const result = computeNextRun(schedule, { from })
    expect(result.nextRunAt).toBe(localTs(2026, 9, 21, 9, 30))
  })

  it('每周：同一天但时间未到时取当天', () => {
    const schedule = makeSchedule({ cycleKind: 'weekly', weekDays: [5], onceTime: '18:00' })
    const from = localTs(2026, 9, 18, 12, 0)
    expect(computeNextRun(schedule, { from }).nextRunAt).toBe(localTs(2026, 9, 18, 18, 0))
  })

  it('每月：31 日在 30 天的月份落到当月最后一天', () => {
    const schedule = makeSchedule({ cycleKind: 'monthly', monthDay: 31, onceTime: '10:00' })
    // 2026-09-30 之后应落在 2026-10-31
    const from = localTs(2026, 9, 30, 23, 0)
    expect(computeNextRun(schedule, { from }).nextRunAt).toBe(localTs(2026, 10, 31, 10, 0))
    // 2026-11-01 之后应落在 2026-11-30（当月无 31 日）
    const from2 = localTs(2026, 11, 1, 0, 0)
    expect(computeNextRun(schedule, { from: from2 }).nextRunAt).toBe(localTs(2026, 11, 30, 10, 0))
  })

  it('每年：2-29 在平年落到 2-28', () => {
    const schedule = makeSchedule({
      cycleKind: 'yearly',
      yearMonth: 2,
      yearDay: 29,
      onceTime: '09:00'
    })
    const from = localTs(2027, 1, 1, 0, 0)
    expect(computeNextRun(schedule, { from }).nextRunAt).toBe(localTs(2027, 2, 28, 9, 0))
  })

  it('单次：未执行返回计划时间，已执行返回 finished', () => {
    const schedule = makeSchedule({ cycleKind: 'once', onceDate: '2026-10-01', onceTime: '12:00' })
    const from = localTs(2026, 9, 18, 9, 0)
    expect(computeNextRun(schedule, { from }).nextRunAt).toBe(localTs(2026, 10, 1, 12, 0))
    expect(computeNextRun(schedule, { from, executedOnce: true }).terminal).toBe('finished')
  })

  it('单次：时间已过返回 finished', () => {
    const schedule = makeSchedule({ cycleKind: 'once', onceDate: '2026-09-01', onceTime: '12:00' })
    const from = localTs(2026, 9, 18, 9, 0)
    const result = computeNextRun(schedule, { from })
    expect(result.nextRunAt).toBeNull()
    expect(result.terminal).toBe('finished')
  })
})

describe('computeNextRun - 间隔与有效期', () => {
  it('每隔 N 小时：以上次结束时间为基准', () => {
    const schedule = makeSchedule({
      freqGroup: 'interval',
      intervalKind: 'hourly',
      hourInterval: 3
    })
    const last = localTs(2026, 9, 18, 8, 0)
    const from = localTs(2026, 9, 18, 9, 0)
    expect(computeNextRun(schedule, { from, lastRunAt: last }).nextRunAt).toBe(
      localTs(2026, 9, 18, 11, 0)
    )
  })

  it('每隔 N 小时：基准过旧时向前推进到未来', () => {
    const schedule = makeSchedule({
      freqGroup: 'interval',
      intervalKind: 'hourly',
      hourInterval: 2
    })
    const last = localTs(2026, 9, 18, 1, 0)
    const from = localTs(2026, 9, 18, 9, 30)
    expect(computeNextRun(schedule, { from, lastRunAt: last }).nextRunAt).toBe(
      localTs(2026, 9, 18, 11, 0)
    )
  })

  it('间隔-每周：取下一个命中星期的 00:00', () => {
    const schedule = makeSchedule({
      freqGroup: 'interval',
      intervalKind: 'weekly',
      weekIntervalDays: [2]
    })
    const from = localTs(2026, 9, 18, 12, 0) // 周五
    expect(computeNextRun(schedule, { from }).nextRunAt).toBe(localTs(2026, 9, 22, 0, 0))
  })

  it('有效期结束：返回 expired', () => {
    const schedule = makeSchedule({
      validityMode: 'range',
      validFrom: '2026-09-01',
      validFromTime: '00:00',
      validTo: '2026-09-10',
      validToTime: '23:59'
    })
    const from = localTs(2026, 9, 18, 12, 0)
    const result = computeNextRun(schedule, { from, validToTs: validityBounds(schedule).validToTs })
    expect(result.nextRunAt).toBeNull()
    expect(result.terminal).toBe('expired')
  })

  it('有效期内的下一次触发不会越过结束时间', () => {
    const schedule = makeSchedule({
      onceTime: '09:00',
      validityMode: 'range',
      validFrom: '2026-09-01',
      validFromTime: '00:00',
      validTo: '2026-09-18',
      validToTime: '09:00'
    })
    const bounds = validityBounds(schedule)
    const from = localTs(2026, 9, 18, 8, 30)
    expect(computeNextRun(schedule, { from, validToTs: bounds.validToTs }).nextRunAt).toBe(
      localTs(2026, 9, 18, 9, 0)
    )
    const late = localTs(2026, 9, 18, 9, 30)
    const result = computeNextRun(schedule, { from: late, validToTs: bounds.validToTs })
    expect(result.nextRunAt).toBeNull()
    expect(result.terminal).toBe('expired')
  })
})

describe('摘要文案', () => {
  it('频率摘要与前端展示一致', () => {
    expect(buildFreqSummary(makeSchedule())).toBe('每天 08:00')
    expect(
      buildFreqSummary(makeSchedule({ cycleKind: 'weekly', weekDays: [1, 3], onceTime: '08:00' }))
    ).toBe('每周一、三 08:00')
    expect(
      buildFreqSummary(makeSchedule({ cycleKind: 'monthly', monthDay: 15, onceTime: '09:00' }))
    ).toBe('每月 15 日 09:00')
    expect(
      buildFreqSummary(
        makeSchedule({ freqGroup: 'interval', intervalKind: 'hourly', hourInterval: 4 })
      )
    ).toBe('每隔 4 小时执行 1 次')
  })

  it('有效期摘要', () => {
    expect(buildValiditySummary(makeSchedule())).toBe('长期有效')
    expect(buildValiditySummary(makeSchedule({ cycleKind: 'once' }))).toBe('单次执行')
  })
})
