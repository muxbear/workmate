import type { AutomationService } from './AutomationService'
import type { AutomationRunner } from './AutomationRunner'

/** 兜底轮询间隔：即使没有精确唤醒也会在这个周期内检查一次 */
const TICK_INTERVAL_MS = 60 * 1000
/** 错过触发的补跑宽限：超过则只记一条 skipped */
const CATCH_UP_GRACE_MS = 10 * 60 * 1000
/** 单轮最多处理的任务数 */
const DUE_BATCH_SIZE = 20

export interface AutomationSchedulerDeps {
  service: AutomationService
  runner: AutomationRunner
  /** 当前时间（测试可注入） */
  now?: () => number
  /** 定时器实现（测试可注入） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  log?: (message: string, detail?: unknown) => void
}

/**
 * 自动化调度器
 *
 * 触发方式：精确 setTimeout（按最近一次 next_run_at） + 60 秒兜底 tick。
 * 并发策略：单进程串行执行（每次 tick 依次 await runner.run），任务不可重入。
 * 错过补偿：应用未运行期间错过的触发点，宽限期内补跑一次，超出则记 skipped。
 */
export class AutomationScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private started = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly log: (message: string, detail?: unknown) => void

  constructor(private readonly deps: AutomationSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer))
    this.log =
      deps.log ?? ((message, detail) => console.log('[automation] ' + message, detail ?? ''))
  }

  /** 应用启动：补跑错过的任务 → 启动定时器 → 立即检查一次 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.log('scheduler started')
    await this.catchUpMissed()
    this.scheduleNextTick()
    await this.tick()
  }

  /** 应用退出：停止定时器并把进行中的运行标记为中断 */
  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const interrupted = this.deps.service.markRunningInterrupted(this.now())
    if (interrupted > 0) this.log('marked interrupted runs', interrupted)
    this.log('scheduler stopped')
  }

  /** 系统休眠恢复后调用：立即检查到期任务 */
  async handleResume(): Promise<void> {
    this.log('resume detected, ticking')
    await this.tick()
  }

  /** 处理到期任务（串行，不可重入） */
  async tick(): Promise<void> {
    if (!this.started || this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      const due = this.deps.service.listDueTasks(now, DUE_BATCH_SIZE)
      for (const task of due) {
        if (!this.started) break
        // 重新读取：任务可能在排队期间被暂停、编辑或删除
        const fresh = this.deps.service.findTask(task.userId, task.id)
        if (!fresh || !fresh.enabled || fresh.nextRunAt == null) continue
        try {
          await this.deps.runner.run(fresh, 'schedule', { scheduledAt: fresh.nextRunAt })
        } catch (err) {
          this.log('run failed to start', err instanceof Error ? err.message : err)
        }
      }
    } finally {
      this.ticking = false
      this.scheduleNextTick()
    }
  }

  /** 错过补偿：宽限期内补跑，超出宽限只记 skipped 并重排 */
  private async catchUpMissed(): Promise<void> {
    const now = this.now()
    const due = this.deps.service.listDueTasks(now, DUE_BATCH_SIZE)
    for (const task of due) {
      if (!this.started) break
      // 二次校验：任务可能在应用启动前被暂停或删除
      const fresh = this.deps.service.findTask(task.userId, task.id)
      if (!fresh || !fresh.enabled || fresh.nextRunAt == null) continue
      const overdue = now - (fresh.nextRunAt ?? now)
      if (overdue <= CATCH_UP_GRACE_MS) {
        this.log('catch up task', fresh.title)
        try {
          await this.deps.runner.run(fresh, 'catchup', { scheduledAt: fresh.nextRunAt })
        } catch (err) {
          this.log('catch up failed', err instanceof Error ? err.message : err)
        }
        continue
      }
      this.log('skip missed run', fresh.title)
      this.deps.service.recordSkipped(fresh, 'schedule', '应用未运行，已跳过本次触发', now)
    }
  }

  /** 按最近一次 next_run_at 设置下一次唤醒（最长 60 秒，兜底轮询） */
  private scheduleNextTick(): void {
    if (!this.started) return
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const nextRunAt = this.deps.service.earliestNextRunAt()
    const now = this.now()
    const delay =
      nextRunAt == null
        ? TICK_INTERVAL_MS
        : Math.min(Math.max(nextRunAt - now, 0), TICK_INTERVAL_MS)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }
}
