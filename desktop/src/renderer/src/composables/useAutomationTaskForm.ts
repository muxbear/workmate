import { computed, nextTick, ref, type Ref } from 'vue'
import { useAutomationStore } from '@store/automation'
import type { AutomationSchedule, AutomationTask, AutomationTaskDraft } from '../../../shared/contracts'
import type { PromptPayload } from '@components/PromptInput.vue'

/**
 * 自动化任务表单状态机（R6：自 AutomationTasksPage 外提）。
 *
 * 承载「新建 / 编辑自动化」弹窗的全部状态：名称、频率（单次/每天/每周/每月/每年、
 * 按周/按小时间隔）、有效期（长期/区间）、提示词输入卡引用，以及打开/回填/重置/
 * 保存/删除的完整流程。页面只保留列表与运行记录展示。
 */

type FreqGroup = 'cycle' | 'interval'
type CycleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
type IntervalKind = 'weekly' | 'hourly'

type PromptInputRef = {
  clear: () => void
  setParts: (parts: PromptPayload['parts']) => void
  setText: (text: string) => void
  buildPayload: () => PromptPayload | undefined
} | null

/** 输入卡元素 ref（由页面持有并绑定在模板上，随参数注入本组合件） */
export type AutomationPromptRef = Ref<PromptInputRef>

export function useAutomationTaskForm(promptRef: AutomationPromptRef) {
  const automation = useAutomationStore()

  // ── 新建自动化：表单状态 ──
  const showAdd = ref(false)
  /** 保存中（避免重复提交） */
  const saving = ref(false)
  const taskName = ref('')
  const promptHasContent = ref(false)
  /** 正在编辑的任务 id（null 表示新建） */
  const editingId = ref<string | null>(null)
  /** 待删除确认的任务 */
  const pendingDelete = ref<AutomationTask | null>(null)
  const formError = ref('')

  /** 把输入卡内容标记同步到表单状态（控制「创建任务」按钮可用态） */
  const onPromptHasContent = (value: boolean): void => {
    promptHasContent.value = value
  }

  // ── 频率 / 有效期选项 ──
  const CYCLE_OPTIONS: { key: CycleKind; label: string }[] = [
    { key: 'once', label: '单次' },
    { key: 'daily', label: '每天' },
    { key: 'weekly', label: '每周' },
    { key: 'monthly', label: '每月' },
    { key: 'yearly', label: '每年' }
  ]

  const INTERVAL_OPTIONS: { key: IntervalKind; label: string }[] = [
    { key: 'hourly', label: '按小时' },
    { key: 'weekly', label: '按周' }
  ]

  const WEEK_DAYS: { value: number; label: string }[] = [
    { value: 1, label: '一' },
    { value: 2, label: '二' },
    { value: 3, label: '三' },
    { value: 4, label: '四' },
    { value: 5, label: '五' },
    { value: 6, label: '六' },
    { value: 0, label: '日' }
  ]

  const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)
  const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

  const pad2 = (n: number): string => String(n).padStart(2, '0')

  /** 本地日期字符串（YYYY-MM-DD；offsetDays 用于有效期默认区间） */
  const localDate = (offsetDays = 0): string => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  // ── 频率表单 ──
  const freqGroup = ref<FreqGroup>('cycle')
  const cycleKind = ref<CycleKind>('daily')
  const intervalKind = ref<IntervalKind>('hourly')
  /** 单次/按周期执行的日期与时刻（每天/每周/每月/每年共享时刻） */
  const onceDate = ref(localDate())
  const onceTime = ref('08:00')
  /** 每周（cycle 模式）选中的星期（0=周日） */
  const weekDays = ref<number[]>([1])
  const monthDay = ref(1)
  const yearMonth = ref(1)
  const yearDay = ref(1)
  /** 按周间隔执行的选中星期 */
  const weekIntervalDays = ref<number[]>([1])
  const hourInterval = ref(2)

  // ── 有效期表单 ──
  const validityMode = ref<'forever' | 'range'>('forever')
  const validFrom = ref(localDate())
  const validFromTime = ref('00:00')
  const validTo = ref(localDate(30))
  const validToTime = ref('23:59')

  /** 勾选/取消星期（保持列表升序无关，按值增删） */
  const toggleWeekDay = (list: number[], value: number): void => {
    const idx = list.indexOf(value)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(value)
  }

  /** 星期列表 → 「一、三、五」文案（0=周日排最后） */
  const weekDaysText = (list: number[]): string =>
    [...list]
      .sort((a, b) => a - b)
      .map((v) => WEEK_DAYS.find((d) => d.value === v)?.label ?? '')
      .filter((label) => label.length > 0)
      .join('、')

  /** 单次任务无需设置有效期 */
  const isOnce = computed(() => freqGroup.value === 'cycle' && cycleKind.value === 'once')

  /** 执行频率摘要（用于任务卡片） */
  const freqSummary = computed(() => {
    if (freqGroup.value === 'cycle') {
      if (cycleKind.value === 'once') return '单次 ' + onceDate.value + ' ' + onceTime.value
      if (cycleKind.value === 'daily') return '每天 ' + onceTime.value
      if (cycleKind.value === 'weekly')
        return '每周' + weekDaysText(weekDays.value) + ' ' + onceTime.value
      if (cycleKind.value === 'monthly') return '每月 ' + monthDay.value + ' 日 ' + onceTime.value
      return '每年 ' + yearMonth.value + ' 月 ' + yearDay.value + ' 日 ' + onceTime.value
    }
    if (intervalKind.value === 'weekly')
      return '每周' + weekDaysText(weekIntervalDays.value) + ' 执行'
    return '每隔 ' + hourInterval.value + ' 小时执行 1 次'
  })

  /** 有效期摘要（用于任务卡片） */
  const validitySummary = computed(() => {
    if (isOnce.value) return '单次执行'
    if (validityMode.value === 'forever') return '长期有效'
    return (
      validFrom.value + ' ' + validFromTime.value + ' 至 ' + validTo.value + ' ' + validToTime.value
    )
  })

  /** 采集当前表单的频率 / 有效期配置（存到任务上，供编辑回填） */
  const captureSchedule = (): AutomationSchedule => ({
    freqGroup: freqGroup.value,
    cycleKind: cycleKind.value,
    intervalKind: intervalKind.value,
    onceDate: onceDate.value,
    onceTime: onceTime.value,
    weekDays: [...weekDays.value],
    monthDay: monthDay.value,
    yearMonth: yearMonth.value,
    yearDay: yearDay.value,
    weekIntervalDays: [...weekIntervalDays.value],
    hourInterval: hourInterval.value,
    validityMode: validityMode.value,
    validFrom: validFrom.value,
    validFromTime: validFromTime.value,
    validTo: validTo.value,
    validToTime: validToTime.value
  })

  /** 用任务上的配置回填表单（模板快捷添加的任务没有配置，保持默认值） */
  const applySchedule = (plan?: AutomationSchedule): void => {
    if (!plan) return
    freqGroup.value = plan.freqGroup
    cycleKind.value = plan.cycleKind
    intervalKind.value = plan.intervalKind
    onceDate.value = plan.onceDate
    onceTime.value = plan.onceTime
    weekDays.value = [...plan.weekDays]
    monthDay.value = plan.monthDay
    yearMonth.value = plan.yearMonth
    yearDay.value = plan.yearDay
    weekIntervalDays.value = [...plan.weekIntervalDays]
    hourInterval.value = plan.hourInterval
    validityMode.value = plan.validityMode
    validFrom.value = plan.validFrom
    validFromTime.value = plan.validFromTime
    validTo.value = plan.validTo
    validToTime.value = plan.validToTime
  }

  /** 重置新建表单（每次打开弹窗都是干净状态） */
  const resetForm = (): void => {
    taskName.value = ''
    formError.value = ''
    promptHasContent.value = false
    promptRef.value?.clear()
    freqGroup.value = 'cycle'
    cycleKind.value = 'daily'
    intervalKind.value = 'hourly'
    onceDate.value = localDate()
    onceTime.value = '08:00'
    weekDays.value = [1]
    monthDay.value = 1
    yearMonth.value = 1
    yearDay.value = 1
    weekIntervalDays.value = [1]
    hourInterval.value = 2
    validityMode.value = 'forever'
    validFrom.value = localDate()
    validFromTime.value = '00:00'
    validTo.value = localDate(30)
    validToTime.value = '23:59'
  }

  /** 打开「新建自动化」弹窗 */
  const openAddModal = (): void => {
    editingId.value = null
    resetForm()
    showAdd.value = true
  }

  /** 打开「编辑自动化」弹窗：回填名称 / 提示词 / 频率 / 有效期 */
  const openEditModal = async (task: AutomationTask): Promise<void> => {
    editingId.value = task.id
    resetForm()
    taskName.value = task.title
    applySchedule(task.schedule)
    formError.value = ''
    showAdd.value = true
    // 输入卡挂在弹窗内，等渲染完成再回填提示词与文件 token
    await nextTick()
    if (task.promptParts.length > 0) promptRef.value?.setParts(task.promptParts)
    else if (task.promptText) promptRef.value?.setText(task.promptText)
  }

  /** 关闭「新建自动化」弹窗并清理草稿 */
  const closeAddModal = (): void => {
    showAdd.value = false
    editingId.value = null
    resetForm()
  }

  /** 打开删除确认 */
  const askDelete = (task: AutomationTask): void => {
    pendingDelete.value = task
  }

  /** 取消删除 */
  const cancelDelete = (): void => {
    pendingDelete.value = null
  }

  /** 确认删除：主进程软删除（运行历史保留） */
  const confirmDelete = async (): Promise<void> => {
    const target = pendingDelete.value
    pendingDelete.value = null
    if (!target) return
    try {
      await automation.deleteTask(target.id)
    } catch (err) {
      automation.error = err instanceof Error ? err.message : '删除失败'
    }
  }

  /** 保存表单为自动化任务：编辑中则更新原任务，否则新建（主进程落库并重算排期） */
  const createTaskFrom = async (payload: PromptPayload): Promise<void> => {
    const hasBody = payload.text.length > 0 || payload.parts.some((p) => p.type === 'file')
    if (!hasBody) {
      formError.value = '请先填写任务描述 / 提示词'
      return
    }
    const draft: AutomationTaskDraft = {
      title: taskName.value.trim() || payload.text.slice(0, 18) || '未命名自动化任务',
      promptText: payload.text,
      promptParts: payload.parts,
      icon: '⏰',
      source: 'custom',
      templateId: null,
      schedule: captureSchedule(),
      model: payload.model,
      customModelId: payload.customModelId ?? null,
      expertId: payload.expertId,
      expertName: payload.expertName,
      contextMode: payload.mode,
      skillIds: payload.skillIds,
      workspaceId: payload.workspaceId,
      workspaceName: payload.workspaceName,
      fullAccess: payload.fullAccess
    }
    saving.value = true
    try {
      if (editingId.value !== null) await automation.updateTask(editingId.value, draft)
      else await automation.createTask(draft)
      formError.value = ''
      await automation.loadStats()
      closeAddModal()
    } catch (err) {
      formError.value = err instanceof Error ? err.message : '保存失败'
    } finally {
      saving.value = false
    }
  }

  const onPromptSubmit = (payload: PromptPayload): void => {
    void createTaskFrom(payload)
  }

  /** 弹窗底部「创建任务」：读取输入卡当前内容 */
  const createTask = (): void => {
    const payload = promptRef.value?.buildPayload()
    if (!payload) return
    void createTaskFrom(payload)
  }

  return {
    showAdd,
    saving,
    taskName,
    promptHasContent,
    editingId,
    pendingDelete,
    formError,
    onPromptHasContent,
    CYCLE_OPTIONS,
    INTERVAL_OPTIONS,
    WEEK_DAYS,
    MONTHS,
    MONTH_DAYS,
    freqGroup,
    cycleKind,
    intervalKind,
    onceDate,
    onceTime,
    weekDays,
    monthDay,
    yearMonth,
    yearDay,
    weekIntervalDays,
    hourInterval,
    validityMode,
    validFrom,
    validFromTime,
    validTo,
    validToTime,
    toggleWeekDay,
    isOnce,
    freqSummary,
    validitySummary,
    captureSchedule,
    applySchedule,
    resetForm,
    openAddModal,
    openEditModal,
    closeAddModal,
    askDelete,
    cancelDelete,
    confirmDelete,
    createTaskFrom,
    onPromptSubmit,
    createTask
  }
}
