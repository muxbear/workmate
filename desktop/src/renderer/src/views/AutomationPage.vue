<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAutomationStore } from '@store/automation'
import type {
  AutomationSchedule,
  AutomationTask,
  AutomationTaskDraft
} from '../../../preload/index.d'
import PromptInput, { type PromptPayload } from '@components/PromptInput.vue'
import ConfirmDialog from '@components/ConfirmDialog.vue'

type Tab = 'tasks' | 'logs'

const automation = useAutomationStore()

/** 运行记录是否还有更多（上一页拿满一页则有） */
const hasMoreRuns = ref(true)
const loadingMore = ref(false)

/** 加载更多运行记录 */
const loadMoreRuns = async (): Promise<void> => {
  if (loadingMore.value) return
  loadingMore.value = true
  try {
    const got = await automation.loadMoreRuns(50)
    if (got < 50) hasMoreRuns.value = false
  } catch {
    hasMoreRuns.value = false
  } finally {
    loadingMore.value = false
  }
}

const tab = ref<Tab>('tasks')
const myTasks = computed(() => automation.tasks)
const showAdd = ref(false)
/** 保存中（避免重复提交） */
const saving = ref(false)
/** 主进程事件取消订阅 */
let unsubscribe: (() => void) | null = null

interface AutomationTemplate {
  id: number
  icon: string
  title: string
  desc: string
  freq: string
  schedule: AutomationSchedule
}

const automationTemplates: AutomationTemplate[] = [
  {
    id: 1,
    icon: '📰',
    title: '每日 AI 新闻推送',
    desc: '关注当天 AI 领域的重要动态，侧重产品与技术突破',
    freq: '每天 08:00',
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
    }
  },
  {
    id: 2,
    icon: '🔤',
    title: '每日 5 个英语单词',
    desc: '每天推荐 5 个高频实用英语单词，配例句与记忆技巧',
    freq: '每天 07:30',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '07:30',
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
    }
  },
  {
    id: 3,
    icon: '🌙',
    title: '每日儿童睡前故事',
    desc: '生成 3-5 分钟可读的温和睡前故事，适合亲子共读',
    freq: '每天 20:30',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '20:30',
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
    }
  },
  {
    id: 4,
    icon: '📋',
    title: '每周工作周报',
    desc: '每周五汇总仓库 PR 与 Issue 进展，自动生成周报草稿',
    freq: '每周五 18:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'weekly',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '18:00',
      weekDays: [5],
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
    }
  },
  {
    id: 5,
    icon: '🎬',
    title: '经典电影推荐',
    desc: '推荐一部高分经典电影，简要介绍背景与观影理由',
    freq: '每周三 12:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'weekly',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '12:00',
      weekDays: [3],
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
    }
  },
  {
    id: 6,
    icon: '📅',
    title: '历史上的今天',
    desc: '从科技、电影、音乐等领域挑选一件有趣的历史事件',
    freq: '每天 09:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '09:00',
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
    }
  },
  {
    id: 7,
    icon: '💡',
    title: '每日一个为什么',
    desc: '每天提出一个有趣问题，先提问再揭晓答案，启发思考',
    freq: '每天 10:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '10:00',
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
    }
  },
  {
    id: 8,
    icon: '📞',
    title: '父母联系提醒',
    desc: '每周日 10:00 提醒你给家人打电话，珍惜家人时光',
    freq: '每周日 10:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'weekly',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '10:00',
      weekDays: [7],
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
    }
  },
  {
    id: 9,
    icon: '🏥',
    title: '体检预约提醒',
    desc: '在指定时间提醒你确认体检预约，提前做好准备',
    freq: '单次 07:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '07:00',
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
    }
  },
  {
    id: 10,
    icon: '💼',
    title: '面试准备提醒',
    desc: '工作日每 2 小时提醒你复习大模型相关知识点',
    freq: '工作日 每2h',
    schedule: {
      freqGroup: 'interval',
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
    }
  },
  {
    id: 11,
    icon: '📝',
    title: '会议前准备',
    desc: '在会议开始前提醒你整理议题，目标与所需材料',
    freq: '会前 15min',
    schedule: {
      freqGroup: 'interval',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '08:00',
      weekDays: [1],
      monthDay: 1,
      yearMonth: 1,
      yearDay: 1,
      weekIntervalDays: [1],
      hourInterval: 1,
      validityMode: 'forever',
      validFrom: '',
      validFromTime: '00:00',
      validTo: '',
      validToTime: '23:59'
    }
  },
  {
    id: 12,
    icon: '🐱',
    title: '可爱萌宠手机壁纸',
    desc: '随机从 7 种风格中挑选一种，生成今日专属萌宠壁纸',
    freq: '每天 07:00',
    schedule: {
      freqGroup: 'cycle',
      cycleKind: 'daily',
      intervalKind: 'hourly',
      onceDate: '',
      onceTime: '07:00',
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
    }
  }
]

/** 模版快捷添加：落库（source 记为 template，便于回显已添加状态） */
const addTask = async (tpl: AutomationTemplate): Promise<void> => {
  if (myTasks.value.some((t) => t.templateId === String(tpl.id))) return
  try {
    await automation.createTask({
      title: tpl.title,
      promptText: tpl.desc,
      promptParts: [{ type: 'text', text: tpl.desc }],
      icon: tpl.icon,
      source: 'template',
      templateId: String(tpl.id),
      schedule: tpl.schedule,
      contextMode: 'default',
      fullAccess: false
    })
    await automation.loadStats()
  } catch (err) {
    automation.error = err instanceof Error ? err.message : '添加失败'
  }
}

// ── 新建自动化：表单状态 ──
const taskName = ref('')
const promptHasContent = ref(false)
const promptRef = ref<InstanceType<typeof PromptInput> | null>(null)
/** 正在编辑的任务 id（null 表示新建） */
const editingId = ref<string | null>(null)
/** 待删除确认的任务 */
const pendingDelete = ref<AutomationTask | null>(null)
const formError = ref('')

/** 把输入卡内容标记同步到表单状态（控制「创建任务」按钮可用态） */
const onPromptHasContent = (value: boolean): void => {
  promptHasContent.value = value
}

type FreqGroup = 'cycle' | 'interval'
type CycleKind = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
type IntervalKind = 'weekly' | 'hourly'

/** 周期：单次 / 每天 / 每周 / 每月 / 每年 */
const CYCLE_OPTIONS: { key: CycleKind; label: string }[] = [
  { key: 'once', label: '单次' },
  { key: 'daily', label: '每天' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' }
]

/** 间隔：每周（选星期）/ 每隔（N 小时执行 1 次） */
const INTERVAL_OPTIONS: { key: IntervalKind; label: string }[] = [
  { key: 'weekly', label: '每周' },
  { key: 'hourly', label: '每隔' }
]

/** 周一至周日（value 1 至 7，7 为周日） */
const WEEK_DAYS: { value: number; label: string }[] = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' }
]

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地日期（YYYY-MM-DD），offsetDays 为相对今天的天数 */
const localDate = (offsetDays = 0): string => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

const freqGroup = ref<FreqGroup>('cycle')
const cycleKind = ref<CycleKind>('daily')
const intervalKind = ref<IntervalKind>('hourly')

// 周期参数
const onceDate = ref(localDate())
const onceTime = ref('08:00')
const weekDays = ref<number[]>([1])
const monthDay = ref(1)
const yearMonth = ref(1)
const yearDay = ref(1)

// 间隔参数
const weekIntervalDays = ref<number[]>([1])
const hourInterval = ref(2)

// 有效期参数
const validityMode = ref<'forever' | 'range'>('forever')
const validFrom = ref(localDate())
const validFromTime = ref('00:00')
const validTo = ref(localDate(30))
const validToTime = ref('23:59')

/** 星期多选：点击切换，至少保留一天 */
const toggleWeekDay = (list: number[], value: number): void => {
  const index = list.indexOf(value)
  if (index >= 0) {
    if (list.length === 1) return
    list.splice(index, 1)
  } else {
    list.push(value)
  }
}

/** 星期多选文案（按周一至周日排序，如「一、三」） */
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

/** 确认删除：从我的任务中移除（模板卡片同步恢复为可添加） */
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

/** 用输入卡快照创建任务；提示词为空时给出内联提示 */
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

/** 运行状态展示元信息 */
const RUN_STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: '运行中', color: '#0891b2' },
  success: { label: '成功', color: '#10b981' },
  failed: { label: '失败', color: '#ef4444' },
  skipped: { label: '跳过', color: '#f59e0b' },
  canceled: { label: '已取消', color: '#94a3b8' },
  interrupted: { label: '已中断', color: '#f97316' }
}

/** 时间文案：今天 08:00 / 昨天 20:30 / 9月18日 08:00 */
function formatRunTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (date.toDateString() === now.toDateString()) return '今天 ' + hh + ':' + mm
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + hh + ':' + mm
  return String(date.getMonth() + 1) + '月' + date.getDate() + '日 ' + hh + ':' + mm
}

/** 任务排期文案 */
function formatNextRun(task: AutomationTask): string {
  if (!task.enabled) return '已暂停'
  if (task.status === 'expired') return '已过期'
  if (task.status === 'finished') return '已完成'
  if (task.nextRunAt == null) return '未排期'
  return '下次 ' + formatRunTime(task.nextRunAt)
}

/** 运行记录展示行 */
const runRows = computed(() =>
  automation.runs.map((run) => {
    const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.running
    return {
      id: run.id,
      taskId: run.taskId,
      name: automation.taskNameById[run.taskId] ?? '已删除的任务',
      status: meta.label,
      color: meta.color,
      time: formatRunTime(run.startedAt),
      duration: run.durationMs == null ? '-' : (run.durationMs / 1000).toFixed(1) + 's',
      reason: run.errorMessage ?? ''
    }
  })
)

/** 统计卡片（本周） */
const statsCards = computed(() => {
  const current = automation.stats
  const total = current?.total ?? 0
  const success = current?.success ?? 0
  const failed = current?.failed ?? 0
  const rate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0
  const skipped = current?.skipped ?? 0
  return [
    {
      label: '本周运行次数',
      value: String(total),
      sub: '成功 ' + success + ' 次 / 失败 ' + failed + ' 次',
      color: '#0891b2'
    },
    {
      label: '成功率',
      value: rate + '%',
      sub: total > 0 ? '按全部运行统计' : '暂无数据',
      color: '#10b981'
    },
    {
      label: '平均耗时',
      value: current?.avgDurationMs == null ? '-' : (current.avgDurationMs / 1000).toFixed(1) + 's',
      sub: skipped > 0 ? '跳过 ' + skipped + ' 次' : '按已完成运行统计',
      color: '#f59e0b'
    }
  ]
})

/** 失败重试：等价于对该任务立即运行一次（保留原失败记录） */
const retryRun = async (taskId: string): Promise<void> => {
  try {
    await automation.runNow(taskId)
  } catch (err) {
    automation.error = err instanceof Error ? err.message : '重试失败'
  }
}

/** 暂停 / 继续 */
const toggleEnabled = async (task: AutomationTask): Promise<void> => {
  try {
    await automation.setEnabled(task.id, !task.enabled)
  } catch (err) {
    automation.error = err instanceof Error ? err.message : '操作失败'
  }
}

/** 首屏加载：任务列表 + 运行记录 + 统计 */
const loadAll = async (): Promise<void> => {
  try {
    await automation.loadTasks()
    await Promise.all([automation.loadRuns({ limit: 50 }), automation.loadStats()])
  } catch {
    // 错误已写入 store.error，页面顶部展示
  }
}

onMounted(() => {
  void loadAll()
  /** 运行状态变化时刷新（主进程广播） */
  unsubscribe = automation.subscribe()
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
<template>
  <div class="auto-page">
    <p v-if="automation.error" class="auto-error">{{ automation.error }}</p>
    <!-- Tabs -->
    <div class="auto-tabs">
      <button
        v-for="[key, label] in [
          ['tasks', '定时任务'],
          ['logs', '运行记录']
        ] as const"
        :key="key"
        :class="['auto-tab', { 'auto-tab--active': tab === key }]"
        @click="tab = key"
      >
        {{ label }}
        <span v-if="tab === key" class="auto-tab-line"></span>
      </button>
    </div>

    <div class="auto-body">
      <Transition name="fade" mode="out-in">
        <!-- ── Tasks Tab ── -->
        <div v-if="tab === 'tasks'" key="tasks">
          <!-- Empty state -->
          <div v-if="myTasks.length === 0" class="empty-state">
            <div class="empty-icon-circle">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle
                  cx="16"
                  cy="16"
                  r="12"
                  stroke="rgba(8,145,178,0.35)"
                  stroke-width="1.8"
                  stroke-dasharray="3 2"
                />
                <circle cx="16" cy="16" r="3" fill="rgba(8,145,178,0.3)" />
                <line
                  x1="16"
                  y1="8"
                  x2="16"
                  y2="13"
                  stroke="rgba(8,145,178,0.4)"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
                <line
                  x1="16"
                  y1="16"
                  x2="20"
                  y2="20"
                  stroke="rgba(8,145,178,0.4)"
                  stroke-width="1.8"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <p class="empty-title">开启你的第一个自动化任务吧</p>
            <p class="empty-desc">从模版选择或自定义定时任务，让KE-WORK自动帮你完成重复工作</p>
            <button class="auto-create-btn" @click="openAddModal">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加自动化
            </button>
          </div>

          <!-- Has tasks -->
          <template v-else>
            <div class="my-tasks-header">
              <h2 class="sec-title">
                我的任务 <span class="task-count">{{ myTasks.length }} 个</span>
              </h2>
              <button class="auto-create-btn auto-create-btn--sm" @click="openAddModal">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                添加自动化
              </button>
            </div>
            <div class="task-grid">
              <div v-for="task in myTasks" :key="task.id" class="task-card">
                <span class="task-icon">{{ task.icon }}</span>
                <div class="task-info">
                  <p class="task-name">{{ task.title }}</p>
                  <p class="task-desc">{{ task.promptText }}</p>
                  <div class="task-foot">
                    <span class="task-meta"
                      ><span class="task-freq">{{ task.freqSummary }}</span
                      ><span class="task-validity">{{ task.validitySummary }}</span
                      ><span class="task-next">{{ formatNextRun(task) }}</span
                      ><span v-if="task.runCount > 0" class="task-runs"
                        >运行 {{ task.runCount }} 次 / 失败 {{ task.failCount }} 次</span
                      ></span
                    >
                    <div class="task-status">
                      <span class="status-dot status-dot--green"></span>
                      运行中
                    </div>
                    <div class="task-actions">
                      <button
                        class="task-action-btn"
                        type="button"
                        :title="task.enabled ? '暂停' : '继续'"
                        @click="toggleEnabled(task)"
                      >
                        <svg
                          v-if="task.enabled"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <rect x="6" y="5" width="4" height="14" rx="1" />
                          <rect x="14" y="5" width="4" height="14" rx="1" />
                        </svg>
                        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="6 4 20 12 6 20 6 4" />
                        </svg>
                      </button>
                      <button
                        class="task-action-btn"
                        type="button"
                        title="编辑"
                        @click="openEditModal(task)"
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                      <button
                        class="task-action-btn task-action-btn--danger"
                        type="button"
                        title="删除"
                        @click="askDelete(task)"
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Templates -->
          <div class="tpl-section">
            <h2 class="sec-title tpl-section-title">自动化任务模版</h2>
            <div class="task-grid">
              <div
                v-for="tpl in automationTemplates"
                :key="tpl.id"
                :class="[
                  'task-card task-card--tpl',
                  { 'task-card--added': myTasks.some((t) => t.templateId === String(tpl.id)) }
                ]"
              >
                <span class="task-icon">{{ tpl.icon }}</span>
                <div class="task-info">
                  <p class="task-name">{{ tpl.title }}</p>
                  <p class="task-desc">{{ tpl.desc }}</p>
                  <div class="task-foot">
                    <span class="task-freq">{{ tpl.freq }}</span>
                    <button
                      :class="[
                        'task-add-btn',
                        {
                          'task-add-btn--added': myTasks.some(
                            (t) => t.templateId === String(tpl.id)
                          )
                        }
                      ]"
                      @click="addTask(tpl)"
                    >
                      {{
                        myTasks.some((t) => t.templateId === String(tpl.id)) ? '✓ 已添加' : '+ 添加'
                      }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Logs Tab ── -->
        <div v-else key="logs">
          <div class="logs-header">
            <h2 class="sec-title">运行记录</h2>
            <span class="logs-range">已加载 {{ runRows.length }} 条</span>
            <button v-if="hasMoreRuns" class="logs-more" @click="loadMoreRuns">加载更多</button>
          </div>
          <div class="logs-table">
            <div class="logs-table-head">
              <span>任务名称</span><span>运行时间</span><span>耗时</span><span>状态</span>
            </div>
            <div
              v-for="(log, i) in runRows"
              :key="log.id"
              class="logs-row"
              :title="log.reason"
              :style="{
                borderBottom: i < runRows.length - 1 ? '1px solid rgba(8,145,178,0.07)' : 'none'
              }"
            >
              <span class="logs-name">{{ log.name }}</span>
              <span class="logs-time">{{ log.time }}</span>
              <span class="logs-dur">{{ log.duration }}</span>
              <div class="logs-status-cell">
                <span class="status-dot" :style="{ background: log.color }"></span>
                <span :style="{ color: log.color, fontWeight: 500 }">{{ log.status }}</span>
                <span v-if="log.reason" class="logs-reason">{{ log.reason }}</span>
                <button
                  v-if="log.status === '失败'"
                  class="logs-retry"
                  @click="retryRun(log.taskId)"
                >
                  重试
                </button>
              </div>
            </div>
            <p v-if="runRows.length === 0" class="run-empty">
              暂无运行记录，创建任务并等待触发后这里会显示结果。
            </p>
          </div>
          <!-- Stats -->
          <div class="stats-grid">
            <div v-for="stat in statsCards" :key="stat.label" class="stat-card">
              <p class="stat-label">{{ stat.label }}</p>
              <p class="stat-value" :style="{ color: stat.color }">{{ stat.value }}</p>
              <p class="stat-sub">{{ stat.sub }}</p>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 新建自动化 -->
    <Transition name="modal">
      <div v-if="showAdd" class="modal-mask" @click.self="closeAddModal">
        <div class="modal-card modal-card--form">
          <div class="modal-header">
            <span>{{ editingId ? '编辑自动化' : '新建自动化' }}</span>
            <button @click="closeAddModal" class="modal-close">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="form-field">
              <label class="modal-label">任务名称</label>
              <input
                v-model="taskName"
                type="text"
                placeholder="例如：每日行业快报推送"
                class="modal-input"
              />
            </div>

            <div class="form-field">
              <label class="modal-label">任务描述 / 提示词</label>
              <PromptInput
                ref="promptRef"
                placeholder="描述你希望 KE-WORK 每次执行的内容…  @ 引用文件，/ 调用技能"
                :submit-label="editingId ? '保存' : '创建任务'"
                menu-placement="down"
                :min-height="68"
                :max-height="220"
                @submit="onPromptSubmit"
                @update:has-content="onPromptHasContent"
              />
            </div>

            <div class="form-field">
              <label class="modal-label">执行频率</label>
              <!-- 一级分类：周期 / 间隔 -->
              <div class="seg-group">
                <button
                  class="seg-btn"
                  :class="{ 'seg-btn--active': freqGroup === 'cycle' }"
                  @click="freqGroup = 'cycle'"
                >
                  周期
                </button>
                <button
                  class="seg-btn"
                  :class="{ 'seg-btn--active': freqGroup === 'interval' }"
                  @click="freqGroup = 'interval'"
                >
                  间隔
                </button>
              </div>

              <template v-if="freqGroup === 'cycle'">
                <!-- 周期：单次 / 每天 / 每周 / 每月 / 每年 -->
                <div class="seg-group seg-group--sub">
                  <button
                    v-for="opt in CYCLE_OPTIONS"
                    :key="opt.key"
                    class="seg-btn seg-btn--sm"
                    :class="{ 'seg-btn--active': cycleKind === opt.key }"
                    @click="cycleKind = opt.key"
                  >
                    {{ opt.label }}
                  </button>
                </div>
                <div class="freq-row">
                  <template v-if="cycleKind === 'once'">
                    <span class="freq-label">日期</span>
                    <input v-model="onceDate" type="date" class="modal-input modal-input--sm" />
                    <span class="freq-label">时间</span>
                    <input v-model="onceTime" type="time" class="modal-input modal-input--sm" />
                  </template>
                  <template v-else-if="cycleKind === 'daily'">
                    <span class="freq-label">时间</span>
                    <input v-model="onceTime" type="time" class="modal-input modal-input--sm" />
                  </template>
                  <template v-else-if="cycleKind === 'weekly'">
                    <span class="freq-label">星期</span>
                    <div class="weekday-picker">
                      <button
                        v-for="day in WEEK_DAYS"
                        :key="day.value"
                        class="weekday-btn"
                        :class="{ 'weekday-btn--active': weekDays.includes(day.value) }"
                        @click="toggleWeekDay(weekDays, day.value)"
                      >
                        {{ day.label }}
                      </button>
                    </div>
                    <span class="freq-label">时间</span>
                    <input v-model="onceTime" type="time" class="modal-input modal-input--sm" />
                  </template>
                  <template v-else-if="cycleKind === 'monthly'">
                    <span class="freq-label">每月</span>
                    <select v-model.number="monthDay" class="modal-input modal-input--sm">
                      <option v-for="d in MONTH_DAYS" :key="d" :value="d">{{ d }}</option>
                    </select>
                    <span class="freq-label">日</span>
                    <span class="freq-label">时间</span>
                    <input v-model="onceTime" type="time" class="modal-input modal-input--sm" />
                  </template>
                  <template v-else>
                    <span class="freq-label">每年</span>
                    <select v-model.number="yearMonth" class="modal-input modal-input--sm">
                      <option v-for="m in MONTHS" :key="m" :value="m">{{ m }}</option>
                    </select>
                    <span class="freq-label">月</span>
                    <select v-model.number="yearDay" class="modal-input modal-input--sm">
                      <option v-for="d in MONTH_DAYS" :key="d" :value="d">{{ d }}</option>
                    </select>
                    <span class="freq-label">日</span>
                    <span class="freq-label">时间</span>
                    <input v-model="onceTime" type="time" class="modal-input modal-input--sm" />
                  </template>
                </div>
              </template>

              <template v-else>
                <!-- 间隔：每周（选星期）/ 每隔（N 小时执行 1 次） -->
                <div class="seg-group seg-group--sub">
                  <button
                    v-for="opt in INTERVAL_OPTIONS"
                    :key="opt.key"
                    class="seg-btn seg-btn--sm"
                    :class="{ 'seg-btn--active': intervalKind === opt.key }"
                    @click="intervalKind = opt.key"
                  >
                    {{ opt.label }}
                  </button>
                </div>
                <div class="freq-row">
                  <template v-if="intervalKind === 'weekly'">
                    <span class="freq-label">星期</span>
                    <div class="weekday-picker">
                      <button
                        v-for="day in WEEK_DAYS"
                        :key="day.value"
                        class="weekday-btn"
                        :class="{ 'weekday-btn--active': weekIntervalDays.includes(day.value) }"
                        @click="toggleWeekDay(weekIntervalDays, day.value)"
                      >
                        {{ day.label }}
                      </button>
                    </div>
                  </template>
                  <template v-else>
                    <span class="freq-label">每隔</span>
                    <input
                      v-model.number="hourInterval"
                      type="number"
                      min="1"
                      max="24"
                      class="modal-input modal-input--num"
                    />
                    <span class="freq-label">小时执行 1 次</span>
                  </template>
                </div>
              </template>

              <p class="freq-summary">执行计划：{{ freqSummary }}</p>
            </div>

            <div class="form-field">
              <label class="modal-label">有效期</label>
              <p v-if="isOnce" class="freq-summary">
                单次任务仅在指定时间执行一次，无需设置有效期。
              </p>
              <template v-else>
                <div class="seg-group">
                  <button
                    class="seg-btn"
                    :class="{ 'seg-btn--active': validityMode === 'forever' }"
                    @click="validityMode = 'forever'"
                  >
                    长期有效
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ 'seg-btn--active': validityMode === 'range' }"
                    @click="validityMode = 'range'"
                  >
                    指定时间段
                  </button>
                </div>
                <div v-if="validityMode === 'range'" class="validity-rows">
                  <div class="freq-row">
                    <span class="freq-label">开始</span>
                    <input v-model="validFrom" type="date" class="modal-input modal-input--sm" />
                    <input
                      v-model="validFromTime"
                      type="time"
                      class="modal-input modal-input--sm"
                    />
                  </div>
                  <div class="freq-row">
                    <span class="freq-label">结束</span>
                    <input v-model="validTo" type="date" class="modal-input modal-input--sm" />
                    <input v-model="validToTime" type="time" class="modal-input modal-input--sm" />
                  </div>
                </div>
                <p class="freq-summary">有效期：{{ validitySummary }}</p>
              </template>
            </div>

            <p v-if="formError" class="form-error">{{ formError }}</p>
          </div>
          <div class="modal-footer">
            <button class="modal-btn modal-btn--cancel" @click="closeAddModal">取消</button>
            <button
              class="modal-btn modal-btn--confirm"
              :disabled="!promptHasContent"
              @click="createTask"
            >
              {{ editingId ? '保存' : '创建任务' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="pendingDelete"
      title="删除自动化任务"
      :message="'确定要删除「' + pendingDelete.title + '」吗？删除后无法恢复。'"
      confirm-text="删除"
      cancel-text="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>

<style scoped>
.auto-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kw-color-surface);
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
}
.auto-tabs {
  display: flex;
  padding: 16px 24px 0;
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}
.auto-tab {
  position: relative;
  padding: 10px 16px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.auto-tab--active {
  color: var(--kw-color-brand);
}
.auto-tab-line {
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 2px;
  background: var(--kw-color-brand);
}
.auto-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}
.auto-body::-webkit-scrollbar {
  display: none;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 20px;
  text-align: center;
}
.empty-icon-circle {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--kw-color-brand-hover);
  border: 1.5px dashed rgba(8, 145, 178, 0.2);
  margin-bottom: 16px;
}
.empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
  margin: 0 0 4px;
}
.empty-desc {
  font-size: 12px;
  color: var(--kw-color-text-faint);
  margin: 0 0 16px;
  max-width: 360px;
}

.auto-create-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: 12px;
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 3px 12px rgba(8, 145, 178, 0.3);
}
.auto-create-btn:active {
  transform: scale(0.97);
}
.auto-create-btn--sm {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 8px;
}

.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}
.task-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--kw-color-text-faint);
  margin-left: 4px;
}
.my-tasks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 0;
  margin-bottom: 12px;
}

.task-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  padding: 0 24px;
}
.task-card {
  display: flex;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
}
.task-card--tpl {
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.task-card--tpl:hover {
  border-color: rgba(8, 145, 178, 0.22);
  background: var(--kw-color-surface);
}
.task-card--added {
  background: var(--kw-color-brand-hover);
  border-color: rgba(8, 145, 178, 0.25);
}
.task-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 2px;
}
.task-info {
  flex: 1;
  min-width: 0;
}
.task-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0 0 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-desc {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  line-height: 1.4;
  margin: 0 0 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.task-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.task-freq {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
}
.task-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #10b981;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
/* 任务卡片操作：hover 时替换「运行中」状态，露出编辑 / 删除 */
.task-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.task-card:hover .task-actions {
  opacity: 1;
}

.task-card:hover .task-status {
  display: none;
}

.task-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.task-action-btn:hover {
  background: var(--kw-color-brand-soft);
}

.task-action-btn--danger {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
}

.task-action-btn--danger:hover {
  background: rgba(239, 68, 68, 0.16);
}

.status-dot--green {
  background: #10b981;
}
.task-add-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.task-add-btn--added {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}

.tpl-section {
  margin-top: 32px;
  padding-bottom: 32px;
}
.tpl-section-title {
  padding: 0 24px;
  margin-bottom: 12px;
}

.logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
}
.logs-range {
  font-size: 12px;
  color: var(--kw-color-text-faint);
}
.logs-table {
  margin: 0 24px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border-brand);
  overflow: hidden;
}
.logs-table-head {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 10px 16px;
  background: var(--kw-color-brand-hover);
  border-bottom: 1px solid var(--kw-color-border-brand);
  font-size: 11px;
  font-weight: 600;
  color: var(--kw-color-text-muted);
}
.logs-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;
  padding: 12px 16px;
  font-size: 12px;
  transition: background 0.15s;
}
.logs-row:hover {
  background: var(--kw-color-brand-subtle);
}
.logs-name {
  color: var(--kw-color-text);
  font-weight: 500;
}
.logs-time,
.logs-dur {
  color: var(--kw-color-text-secondary);
}
.logs-status-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.logs-retry {
  margin-left: auto;
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.logs-row:hover .logs-retry {
  opacity: 1;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding: 20px 24px 32px;
}
.stat-card {
  padding: 16px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
}
.stat-label {
  font-size: 11px;
  color: var(--kw-color-text-muted);
  margin: 0 0 4px;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 2px;
}
.stat-sub {
  font-size: 10px;
  color: var(--kw-color-text-faint);
  margin: 0;
}

/* Modal */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}
.modal-card {
  width: 420px;
  background: var(--kw-color-surface);
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}
.modal-close {
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  padding: 4px;
}
.modal-body {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}
.modal-input,
.modal-textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1.5px solid var(--kw-color-border-brand);
  border-radius: 12px;
  background: var(--kw-color-input-bg);
  outline: none;
  font-size: 14px;
  font-family: inherit;
  color: var(--kw-color-text);
  box-sizing: border-box;
  resize: none;
}
.modal-input::placeholder,
.modal-textarea::placeholder {
  color: var(--kw-color-text-faint);
}
.modal-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.modal-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
}
.modal-btn {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.modal-btn--cancel {
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-muted);
}
.modal-btn--confirm {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 10px rgba(8, 145, 178, 0.3);
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s;
}
.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 0.2s;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-card {
  transform: scale(0.92);
}
.modal-leave-to .modal-card {
  transform: scale(0.92);
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.18s,
    transform 0.18s;
}
.fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.fade-leave-to {
  opacity: 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   新建自动化：弹窗与表单（执行频率 / 有效期）
   ═══════════════════════════════════════════════════════════════════════════ */
/* 弹窗加宽并允许内部下拉 / 菜单溢出显示；遮罩整体滚动，顶部留出「+」菜单展开空间 */
.modal-mask {
  align-items: flex-start;
  overflow-y: auto;
  padding: 64px 20px 40px;
}

.modal-card--form {
  width: 720px;
  max-width: 100%;
  overflow: visible;
}

.modal-body {
  gap: 12px;
}

.modal-card--form .modal-body {
  padding: 14px 24px 8px;
}

.modal-card--form .modal-footer {
  padding: 0 24px 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 分段选择（周期 / 间隔、单次 / 每天 / …） */
.seg-group {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 10px;
  background: var(--kw-color-brand-hover);
}

.seg-group--sub {
  margin-top: 2px;
  background: var(--kw-color-bg-tint);
}

.seg-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.seg-btn:hover {
  color: var(--kw-color-brand);
}

.seg-btn--active {
  background: var(--kw-color-surface);
  color: var(--kw-color-brand);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(8, 145, 178, 0.16);
}

.seg-btn--sm {
  padding: 4px 10px;
}

/* 频率参数行 */
.freq-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.freq-label {
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.modal-input--sm {
  width: auto;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 8px;
}

.modal-input--num {
  width: 72px;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 8px;
}

/* 星期多选 */
.weekday-picker {
  display: flex;
  gap: 4px;
}

.weekday-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 8px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.weekday-btn:hover {
  border-color: rgba(8, 145, 178, 0.35);
  color: var(--kw-color-brand);
}

.weekday-btn--active {
  border-color: transparent;
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  font-weight: 600;
}

/* 有效期区间 */
.validity-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 频率 / 有效期摘要 */
.freq-summary {
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
  font-size: 12px;
  line-height: 1.5;
}

.form-error {
  margin: 0;
  color: var(--kw-color-danger);
  font-size: 12px;
}

/* 任务卡片：频率 + 有效期 */
.task-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 运行记录：加载更多与失败原因 */
.logs-more {
  padding: 4px 10px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 8px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.logs-more:hover {
  background: var(--kw-color-brand-soft);
}

.logs-reason {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--kw-color-text-faint);
}

/* 任务卡片：运行次数 */
.task-runs {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

/* 下次运行时间 */
.task-next {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
  font-size: 10px;
  white-space: nowrap;
}

/* 运行记录空态 */
.run-empty {
  margin: 0;
  padding: 24px 16px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
  text-align: center;
}

/* 错误提示条 */
.auto-error {
  margin: 12px 24px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
  font-size: 12px;
}

.task-validity {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.modal-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 1024px) {
  .task-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .stats-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 768px) {
  .task-grid {
    grid-template-columns: 1fr;
  }
  .stats-grid {
    grid-template-columns: 1fr;
  }
  .modal-card {
    width: 90vw;
  }
  .auto-tabs {
    padding: 12px 16px 0;
  }
}
</style>
