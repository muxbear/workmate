import { nextTick, ref } from 'vue'
import type { IpcResult, WebUser } from '../../../shared/contracts'

/**
 * 同步类 store 的统一核心（R7-4′：三域 0.94 相似度的复制式扩张收敛）。
 *
 * 专家（expertSync）/ 定时模板（automationTemplateSync）/ 技能（skillSync）三个 store
 * 的「状态字段 + loadStatus/loadLocal/authorize/sync/disconnect/resetLocal」骨架同构，
 * 差异只有：api 命名空间、进度/错误文案、结果如何写入各域数据（catalog / 本地列表）、
 * 删除流程的域特定部分。核心在此实现一次，三个 store 变成薄壳。
 */

/** 同步状态（unknown=未读取；syncing 仅为技能域契约中的历史值，核心不主动设置） */
export type SyncCoreState = 'unknown' | 'unauthorized' | 'authorized' | 'syncing'

/** 进度事件的最小结构（三域 Progress 类型同构：phase/percent/message） */
export interface SyncCoreProgress {
  phase: string
  percent: number
  message?: string
}

/** 三域同步 API 的公共面（结构子集；delete/install 等域特定方法留在薄壳） */
export interface SyncCoreApi<TLocal> {
  getStatus(): Promise<IpcResult<{ status: SyncCoreState; webUser?: WebUser | null }>>
  authorize(): Promise<IpcResult<{ webUser: WebUser | null }>>
  sync(): Promise<IpcResult<TLocal>>
  loadLocal(): Promise<IpcResult<TLocal | null>>
  disconnect(): Promise<IpcResult<unknown>>
  onSyncProgress(callback: (progress: SyncCoreProgress) => void): () => void
}

export interface SyncCoreConfig<TLocal, TStats> {
  /** 惰性取该域 api 命名空间（测试在 store 创建前 stub window） */
  api: () => SyncCoreApi<TLocal>
  /** 同步各阶段文案（逐字保留各域既有文案） */
  texts: {
    /** sync 开始 */
    checking: string
    /** 授权完成后进入拉取阶段 */
    fetching: string
    /** sync 成功收尾 */
    done: string
    /** loadLocal 失败且无主进程错误时的兜底文案 */
    loadLocalFailed: string
    /** 删除流程抛出非 Error 时的兜底文案 */
    removeFailed: string
  }
  /** 把同步/本地读取结果写入本域（catalog 写入、列表替换等） */
  applyLocal(data: TLocal): void
  readSyncedAt(data: TLocal): number
  readStats(data: TLocal): TStats | null
  /** resetLocal 的域清理钩子（catalog 清空、列表清空等） */
  clearLocal(): void
}

/**
 * 创建同步核心：返回共享状态与操作，薄壳 store 直接透出 + 追加域特定方法。
 */
export function createSyncCore<TLocal, TStats>(config: SyncCoreConfig<TLocal, TStats>) {
  const status = ref<SyncCoreState>('unknown')
  const webUser = ref<WebUser | null>(null)
  const lastSyncedAt = ref<number | null>(null)
  const error = ref<string | null>(null)
  /** 是否正在同步 / 读取（进度条显示与按钮禁用依据） */
  const syncing = ref(false)
  /** 同步进度 0–100 */
  const percent = ref(0)
  const progressMessage = ref('')
  /** 最近一次同步的版本比对统计（新增 / 更新 / 保留本地） */
  const stats = ref<TStats | null>(null)
  /** 正在删除的条目 id（删除按钮禁用依据） */
  const removingId = ref<string | null>(null)

  async function loadStatus(): Promise<void> {
    const result = await config.api().getStatus()
    if (!result.success) {
      status.value = 'unauthorized'
      error.value = result.error || '读取同步状态失败'
      return
    }
    status.value = result.data?.status ?? 'unauthorized'
    webUser.value = result.data?.webUser ?? null
    error.value = null
  }

  /** 读取本地文件并回显（页面挂载 / 同步完成后调用）；成功返回 true */
  async function loadLocal(): Promise<boolean> {
    try {
      const result = await config.api().loadLocal()
      if (!result.success) throw new Error(result.error || config.texts.loadLocalFailed)
      const data = result.data
      if (data) {
        config.applyLocal(data)
        lastSyncedAt.value = config.readSyncedAt(data)
      }
      error.value = null
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : config.texts.loadLocalFailed
      return false
    }
  }

  async function authorize(): Promise<void> {
    const result = await config.api().authorize()
    if (!result.success) throw new Error(result.error || '授权失败')
    status.value = 'authorized'
    webUser.value = result.data?.webUser ?? null
  }

  /** 完整同步：授权（如需）→ 拉取 → 版本比对合并 → 落盘 → 读回展示；成功返回 true */
  async function sync(): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    error.value = null
    stats.value = null
    percent.value = 0
    progressMessage.value = config.texts.checking
    let unlisten: (() => void) | null = null
    try {
      if (status.value !== 'authorized') {
        percent.value = 5
        progressMessage.value = '正在等待浏览器授权…'
        await authorize()
      }
      percent.value = 10
      progressMessage.value = config.texts.fetching
      unlisten = config.api().onSyncProgress((p) => {
        // error 阶段由 invoke 结果统一表达，进度事件里的 error 不做展示（避免双提示）
        if (p.phase === 'error') return
        percent.value = p.percent
        progressMessage.value = p.message || progressMessage.value
      })
      const result = await config.api().sync()
      if (!result.success) throw new Error(result.error || '同步失败')
      const data = result.data
      if (!data) throw new Error('同步结果为空')
      config.applyLocal(data)
      lastSyncedAt.value = config.readSyncedAt(data)
      stats.value = config.readStats(data)
      percent.value = 100
      progressMessage.value = config.texts.done
      await nextTick()
      return true
    } catch (err) {
      status.value = webUser.value ? 'authorized' : 'unauthorized'
      error.value = err instanceof Error ? err.message : '同步失败'
      percent.value = 0
      return false
    } finally {
      if (unlisten) unlisten()
      syncing.value = false
    }
  }

  async function disconnect(): Promise<void> {
    const result = await config.api().disconnect()
    if (!result.success) {
      error.value = result.error || '断开连接失败'
      return
    }
    resetLocal()
  }

  /**
   * 删除流程骨架：removingId 期间拒绝重入；域特定的删除请求与本地列表更新在 perform 内。
   * perform 抛错（含 !success 的转抛）→ 记录 error 返回 false，列表由 perform 自行保证不被破坏。
   */
  async function runRemoval(id: string, perform: (id: string) => Promise<void>): Promise<boolean> {
    if (removingId.value) return false
    removingId.value = id
    error.value = null
    try {
      await perform(id)
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : config.texts.removeFailed
      return false
    } finally {
      removingId.value = null
    }
  }

  function resetLocal(): void {
    status.value = 'unknown'
    webUser.value = null
    lastSyncedAt.value = null
    error.value = null
    syncing.value = false
    percent.value = 0
    progressMessage.value = ''
    stats.value = null
    removingId.value = null
    config.clearLocal()
  }

  return {
    status,
    webUser,
    lastSyncedAt,
    error,
    syncing,
    percent,
    progressMessage,
    stats,
    removingId,
    loadStatus,
    loadLocal,
    authorize,
    sync,
    disconnect,
    runRemoval,
    resetLocal
  }
}
