import type { ComputeNextRunResult, TaskSchedule } from './types'

const HOUR_MS = 3600 * 1000

/** 星期文案（索引 0 对应周一） */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 解析 HH:mm，非法时回落到 00:00 */
function parseTime(time: string): { hour: number; minute: number } {
  const parts = String(time).trim().split(':')
  const hour = Number(parts[0])
  const minute = Number(parts[1])
  if (parts.length !== 2) return { hour: 0, minute: 0 }
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return { hour: 0, minute: 0 }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { hour: 0, minute: 0 }
  return { hour, minute }
}

/** 解析 YYYY-MM-DD，非法返回 null */
function parseDate(date: string): { year: number; month: number; day: number } | null {
  const parts = String(date).trim().split('-')
  if (parts.length !== 3) return null
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** 构造本地时区时间戳（month 为 1 到 12） */
function localTs(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

/** ISO 星期：1 为周一、7 为周日 */
function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1
}

/** 指定月份的天数（month 为 1 到 12） */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 星期列表去重排序并过滤非法值 */
export function normalizeWeekDays(days: number[]): number[] {
  const valid = days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
  return Array.from(new Set(valid)).sort((a, b) => a - b)
}

/** 星期文案，例如 一、三 */
export function weekDaysText(days: number[]): string {
  return normalizeWeekDays(days)
    .map((d) => WEEKDAY_LABELS[d - 1])
    .join('、')
}

/** 找出 from 之后最近的命中星期 */
function nextWeekly(from: number, weekDays: number[], hour: number, minute: number): number | null {
  const days = normalizeWeekDays(weekDays)
  if (days.length === 0) return null
  const base = new Date(from)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + offset,
      hour,
      minute,
      0,
      0
    )
    if (days.includes(isoWeekday(candidate)) && candidate.getTime() > from) {
      return candidate.getTime()
    }
  }
  return null
}

/** 每月第 day 天（超出当月天数时落到当月最后一天），找 from 之后最近一次 */
function nextMonthly(from: number, day: number, hour: number, minute: number): number | null {
  const target = Math.min(Math.max(1, Math.floor(day)), 31)
  const base = new Date(from)
  for (let i = 0; i < 24; i++) {
    const probe = new Date(base.getFullYear(), base.getMonth() + i, 1)
    const year = probe.getFullYear()
    const month = probe.getMonth() + 1
    const clamped = Math.min(target, daysInMonth(year, month))
    const candidate = localTs(year, month, clamped, hour, minute)
    if (candidate > from) return candidate
  }
  return null
}

/** 每年 month 月 day 日（闰年 2-29 在平年落到 2-28），找 from 之后最近一次 */
function nextYearly(
  from: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number | null {
  const safeMonth = Math.min(Math.max(1, Math.floor(month)), 12)
  const target = Math.max(1, Math.floor(day))
  const startYear = new Date(from).getFullYear()
  for (let i = 0; i < 8; i++) {
    const year = startYear + i
    const clamped = Math.min(target, daysInMonth(year, safeMonth))
    const candidate = localTs(year, safeMonth, clamped, hour, minute)
    if (candidate > from) return candidate
  }
  return null
}

/** 有效期边界（毫秒），长期有效或单次任务返回 null */
export function validityBounds(schedule: TaskSchedule): {
  validFromTs: number | null
  validToTs: number | null
} {
  if (schedule.validityMode !== 'range') return { validFromTs: null, validToTs: null }
  const fromDate = parseDate(schedule.validFrom)
  const toDate = parseDate(schedule.validTo)
  const fromTime = parseTime(schedule.validFromTime)
  const toTime = parseTime(schedule.validToTime)
  return {
    validFromTs: fromDate
      ? localTs(fromDate.year, fromDate.month, fromDate.day, fromTime.hour, fromTime.minute)
      : null,
    validToTs: toDate
      ? localTs(toDate.year, toDate.month, toDate.day, toTime.hour, toTime.minute)
      : null
  }
}

export interface ComputeNextRunOptions {
  /** 计算基准时间（毫秒），一般为当前时间或上次运行结束时间 */
  from: number
  validToTs?: number | null
  /** 上次运行结束时间（间隔-每隔以此为基准） */
  lastRunAt?: number | null
  /** 单次任务是否已执行过 */
  executedOnce?: boolean
}

/**
 * 计算下一次触发时间
 *
 * - 有效期结束：返回 terminal 为 expired
 * - 单次任务已执行或时间已过：返回 terminal 为 finished
 * - 间隔-每隔以「上次运行结束时间 + N 小时」为基准，避免堆积
 */
export function computeNextRun(
  schedule: TaskSchedule,
  opts: ComputeNextRunOptions
): ComputeNextRunResult {
  const from = opts.from
  const validToTs = opts.validToTs ?? null

  const clamp = (ts: number | null): ComputeNextRunResult => {
    if (ts == null) return { nextRunAt: null, terminal: 'expired' }
    if (validToTs != null && ts > validToTs) return { nextRunAt: null, terminal: 'expired' }
    return { nextRunAt: ts }
  }

  if (validToTs != null && from > validToTs) return { nextRunAt: null, terminal: 'expired' }

  const time = parseTime(schedule.onceTime)

  if (schedule.freqGroup === 'cycle') {
    if (schedule.cycleKind === 'once') {
      if (opts.executedOnce) return { nextRunAt: null, terminal: 'finished' }
      const date = parseDate(schedule.onceDate)
      if (!date) return { nextRunAt: null, terminal: 'finished' }
      const ts = localTs(date.year, date.month, date.day, time.hour, time.minute)
      if (ts <= from) return { nextRunAt: null, terminal: 'finished' }
      return clamp(ts)
    }
    if (schedule.cycleKind === 'daily') {
      const base = new Date(from)
      let ts = localTs(
        base.getFullYear(),
        base.getMonth() + 1,
        base.getDate(),
        time.hour,
        time.minute
      )
      if (ts <= from) {
        ts = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + 1,
          time.hour,
          time.minute,
          0,
          0
        ).getTime()
      }
      return clamp(ts)
    }
    if (schedule.cycleKind === 'weekly') {
      return clamp(nextWeekly(from, schedule.weekDays, time.hour, time.minute))
    }
    if (schedule.cycleKind === 'monthly') {
      return clamp(nextMonthly(from, schedule.monthDay, time.hour, time.minute))
    }
    return clamp(nextYearly(from, schedule.yearMonth, schedule.yearDay, time.hour, time.minute))
  }

  if (schedule.intervalKind === 'weekly') {
    return clamp(nextWeekly(from, schedule.weekIntervalDays, 0, 0))
  }

  const hours = Math.min(Math.max(1, Math.floor(schedule.hourInterval)), 24)
  const step = hours * HOUR_MS
  let base = opts.lastRunAt != null && opts.lastRunAt > 0 ? opts.lastRunAt : from
  let next = base + step
  while (next <= from) next += step
  base = next
  return clamp(base)
}

/** 频率摘要文案（列表直接展示，与前端 buildFreqSummary 保持一致） */
export function buildFreqSummary(schedule: TaskSchedule): string {
  if (schedule.freqGroup === 'cycle') {
    if (schedule.cycleKind === 'once') return '单次 ' + schedule.onceDate + ' ' + schedule.onceTime
    if (schedule.cycleKind === 'daily') return '每天 ' + schedule.onceTime
    if (schedule.cycleKind === 'weekly') {
      return '每周' + weekDaysText(schedule.weekDays) + ' ' + schedule.onceTime
    }
    if (schedule.cycleKind === 'monthly') {
      return '每月 ' + schedule.monthDay + ' 日 ' + schedule.onceTime
    }
    return '每年 ' + schedule.yearMonth + ' 月 ' + schedule.yearDay + ' 日 ' + schedule.onceTime
  }
  if (schedule.intervalKind === 'weekly') {
    return '每周' + weekDaysText(schedule.weekIntervalDays) + ' 执行'
  }
  return '每隔 ' + schedule.hourInterval + ' 小时执行 1 次'
}

/** 有效期摘要文案 */
export function buildValiditySummary(schedule: TaskSchedule): string {
  if (schedule.freqGroup === 'cycle' && schedule.cycleKind === 'once') return '单次执行'
  if (schedule.validityMode === 'forever') return '长期有效'
  return (
    schedule.validFrom +
    ' ' +
    schedule.validFromTime +
    ' 至 ' +
    schedule.validTo +
    ' ' +
    schedule.validToTime
  )
}
