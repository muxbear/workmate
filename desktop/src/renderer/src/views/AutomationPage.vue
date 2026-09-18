<script setup lang="ts">
import { computed, ref } from 'vue'
import PromptInput from '@components/PromptInput.vue'
import type { Mode } from '@store/catalog'
import type { MessagePart } from '../../../preload/index.d'

type Tab = 'tasks' | 'logs'
const tab = ref<Tab>('tasks')
const myTasks = ref<AutomationTask[]>([])
const showAdd = ref(false)

const automationTemplates = [
  {
    id: 1,
    icon: '📰',
    title: '每日 AI 新闻推送',
    desc: '关注当天 AI 领域的重要动态，侧重产品与技术突破',
    freq: '每天 08:00'
  },
  {
    id: 2,
    icon: '🔤',
    title: '每日 5 个英语单词',
    desc: '每天推荐 5 个高频实用英语单词，配例句与记忆技巧',
    freq: '每天 07:30'
  },
  {
    id: 3,
    icon: '🌙',
    title: '每日儿童睡前故事',
    desc: '生成 3-5 分钟可读的温和睡前故事，适合亲子共读',
    freq: '每天 20:30'
  },
  {
    id: 4,
    icon: '📋',
    title: '每周工作周报',
    desc: '每周五汇总仓库 PR 与 Issue 进展，自动生成周报草稿',
    freq: '每周五 18:00'
  },
  {
    id: 5,
    icon: '🎬',
    title: '经典电影推荐',
    desc: '推荐一部高分经典电影，简要介绍背景与观影理由',
    freq: '每周三 12:00'
  },
  {
    id: 6,
    icon: '📅',
    title: '历史上的今天',
    desc: '从科技、电影、音乐等领域挑选一件有趣的历史事件',
    freq: '每天 09:00'
  },
  {
    id: 7,
    icon: '💡',
    title: '每日一个为什么',
    desc: '每天提出一个有趣问题，先提问再揭晓答案，启发思考',
    freq: '每天 10:00'
  },
  {
    id: 8,
    icon: '📞',
    title: '父母联系提醒',
    desc: '每周日 10:00 提醒你给家人打电话，珍惜家人时光',
    freq: '每周日 10:00'
  },
  {
    id: 9,
    icon: '🏥',
    title: '体检预约提醒',
    desc: '在指定时间提醒你确认体检预约，提前做好准备',
    freq: '单次 07:00'
  },
  {
    id: 10,
    icon: '💼',
    title: '面试准备提醒',
    desc: '工作日每 2 小时提醒你复习大模型相关知识点',
    freq: '工作日 每2h'
  },
  {
    id: 11,
    icon: '📝',
    title: '会议前准备',
    desc: '在会议开始前提醒你整理议题，目标与所需材料',
    freq: '会前 15min'
  },
  {
    id: 12,
    icon: '🐱',
    title: '可爱萌宠手机壁纸',
    desc: '随机从 7 种风格中挑选一种，生成今日专属萌宠壁纸',
    freq: '每天 07:00'
  }
]

const runLogs = [
  {
    id: 1,
    name: '每日 AI 新闻推送',
    status: '成功',
    time: '今天 08:00',
    duration: '3.2s',
    color: '#10b981'
  },
  {
    id: 2,
    name: '每日 5 个英语单词',
    status: '成功',
    time: '今天 07:30',
    duration: '1.8s',
    color: '#10b981'
  },
  {
    id: 3,
    name: '每日一个为什么',
    status: '成功',
    time: '今天 10:00',
    duration: '2.1s',
    color: '#10b981'
  },
  {
    id: 4,
    name: '历史上的今天',
    status: '失败',
    time: '今天 09:00',
    duration: '—',
    color: '#ef4444'
  },
  {
    id: 5,
    name: '每日 AI 新闻推送',
    status: '成功',
    time: '昨天 08:00',
    duration: '2.9s',
    color: '#10b981'
  },
  {
    id: 6,
    name: '每日儿童睡前故事',
    status: '成功',
    time: '昨天 20:30',
    duration: '4.5s',
    color: '#10b981'
  },
  {
    id: 7,
    name: '每周工作周报',
    status: '成功',
    time: '周五 18:00',
    duration: '6.1s',
    color: '#10b981'
  },
  {
    id: 8,
    name: '父母联系提醒',
    status: '跳过',
    time: '周日 10:00',
    duration: '—',
    color: '#f59e0b'
  }
]

const stats = [
  { label: '本周运行次数', value: '24', sub: '较上周 +3', color: '#0891b2' },
  { label: '成功率', value: '87.5%', sub: '7 次成功 / 1 次失败', color: '#10b981' },
  { label: '平均耗时', value: '3.4s', sub: '最长 6.1s', color: '#f59e0b' }
]

/** 自动化任务（我的任务列表项） */
interface AutomationTask {
  id: number
  icon: string
  title: string
  desc: string
  /** 执行频率摘要（如「每天 08:00」） */
  freq: string
  /** 有效期摘要（如「长期有效」） */
  validity?: string
  /** 提示词快照（文本段 + 文件引用段） */
  parts?: MessagePart[]
  model?: string
  expertName?: string | null
  workspaceName?: string | null
  fullAccess?: boolean
}

/** 输入卡提交上来的快照（与 PromptInput 的 PromptPayload 结构一致） */
interface PromptPayload {
  parts: MessagePart[]
  text: string
  model: string
  customModelId?: string
  expertId: string | null
  expertName: string | null
  mode: Mode
  skillIds: string[]
  fileCount: number
  workspaceId: string | null
  workspaceName: string | null
  fullAccess: boolean
}

/** 把输入卡的内容标记同步到表单状态（用于「创建任务」按钮可用态） */
const onPromptHasContent = (value: boolean): void => {
  promptHasContent.value = value
}

// ── 新建自动化：表单状态 ──
const taskName = ref('')
const promptHasContent = ref(false)
const promptRef = ref<InstanceType<typeof PromptInput> | null>(null)
const formError = ref('')

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
  resetForm()
  showAdd.value = true
}

/** 关闭「新建自动化」弹窗并清理草稿 */
const closeAddModal = (): void => {
  showAdd.value = false
  resetForm()
}

/** 用输入卡快照创建任务；提示词为空时给出内联提示 */
const createTaskFrom = (payload: PromptPayload): void => {
  const hasBody = payload.text.length > 0 || payload.parts.some((p) => p.type === 'file')
  if (!hasBody) {
    formError.value = '请先填写任务描述 / 提示词'
    return
  }
  const title = taskName.value.trim() || payload.text.slice(0, 18) || '未命名自动化任务'
  myTasks.value.unshift({
    id: Date.now(),
    icon: '⏰',
    title,
    desc: payload.text || '（含文件引用）',
    freq: freqSummary.value,
    validity: validitySummary.value,
    parts: payload.parts,
    model: payload.model,
    expertName: payload.expertName,
    workspaceName: payload.workspaceName,
    fullAccess: payload.fullAccess
  })
  formError.value = ''
  closeAddModal()
}

/** 输入卡回车 / 发送按钮：直接创建任务 */
const onPromptSubmit = (payload: PromptPayload): void => {
  createTaskFrom(payload)
}

/** 弹窗底部「创建任务」：读取输入卡当前内容 */
const createTask = (): void => {
  const payload = promptRef.value?.buildPayload()
  if (!payload) return
  createTaskFrom(payload)
}
const addTask = (tpl: (typeof automationTemplates)[0]): void => {
  if (!myTasks.value.find((t) => t.id === tpl.id)) myTasks.value.push(tpl)
}
</script>

<template>
  <div class="auto-page">
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
                  <p class="task-desc">{{ task.desc }}</p>
                  <div class="task-foot">
                    <span class="task-meta"
                      ><span class="task-freq">{{ task.freq }}</span
                      ><span class="task-validity">{{ task.validity ?? '长期有效' }}</span></span
                    >
                    <div class="task-status">
                      <span class="status-dot status-dot--green"></span>
                      运行中
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
                  { 'task-card--added': myTasks.some((t) => t.id === tpl.id) }
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
                        { 'task-add-btn--added': myTasks.some((t) => t.id === tpl.id) }
                      ]"
                      @click="addTask(tpl)"
                    >
                      {{ myTasks.some((t) => t.id === tpl.id) ? '✓ 已添加' : '+ 添加' }}
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
            <span class="logs-range">最近 7 天</span>
          </div>
          <div class="logs-table">
            <div class="logs-table-head">
              <span>任务名称</span><span>运行时间</span><span>耗时</span><span>状态</span>
            </div>
            <div
              v-for="(log, i) in runLogs"
              :key="log.id"
              class="logs-row"
              :style="{
                borderBottom: i < runLogs.length - 1 ? '1px solid rgba(8,145,178,0.07)' : 'none'
              }"
            >
              <span class="logs-name">{{ log.name }}</span>
              <span class="logs-time">{{ log.time }}</span>
              <span class="logs-dur">{{ log.duration }}</span>
              <div class="logs-status-cell">
                <span class="status-dot" :style="{ background: log.color }"></span>
                <span :style="{ color: log.color, fontWeight: 500 }">{{ log.status }}</span>
                <button v-if="log.status === '失败'" class="logs-retry">重试</button>
              </div>
            </div>
          </div>
          <!-- Stats -->
          <div class="stats-grid">
            <div v-for="stat in stats" :key="stat.label" class="stat-card">
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
            <span>新建自动化</span>
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
                submit-label="创建任务"
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
              创建任务
            </button>
          </div>
        </div>
      </div>
    </Transition>
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

/* 弹窗内压缩提示词输入框高度，保证表单在一屏内可完成 */
.modal-card--form :deep(.task-textarea) {
  min-height: 68px;
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
