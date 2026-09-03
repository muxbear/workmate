<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from 'vue'
import * as echarts from 'echarts'
import {
  fetchResourceStats,
  fetchSystemHealth,
  fetchKpi,
  fetchUsageTrend,
  fetchProviderUsage,
  fetchTopUsers,
  type ResourceStats,
  type SystemHealth,
  type KpiData,
  type TrendPoint,
  type ProviderUsageItem,
  type TopUser,
  type SystemMetrics,
  type TokenStats,
  type SystemEventItem,
  fetchSystemMetrics,
  fetchTokenStats,
  fetchEvents,
} from '@/services/overviewApi'
import {
  Users,
  Activity,
  BarChart3,
  Server,
  Wrench,
  Zap,
  Target,
  Bot,
  Layers,
  Globe,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Shield,
  MessageSquare,
  RefreshCw,
  Clock,
} from 'lucide-vue-next'

/* ---- Types ---- */
type Period = 'day' | 'month' | 'year'
type EventType = 'info' | 'success' | 'warn' | 'error'

interface StatCard {
  label: string
  value: string | number
  sub?: string
  icon: typeof Users
  trend?: number
  iconBg: string
  borderColor: string
}

interface ResourceItem {
  label: string
  value: string
  icon: typeof Wrench
  color: string
  borderColor: string
}

interface TopUser {
  name: string
  role: string
  calls: number
  tokens: string
  online: boolean
}

interface ModelProvider {
  name: string
  models: number
  color: string
  icon: string
  usage: number
  popular: string
}

interface SystemMetric {
  label: string
  value: string
  pct: number
  color: string
}

interface LogEvent {
  time: string
  type: EventType
  msg: string
  icon: typeof Bot
}

/* ---- State ---- */
const period = ref<Period>('day')
const currentTime = ref(new Date())
let clockTimer: ReturnType<typeof setInterval> | null = null

/* ---- API Data ---- */
const resourceStats = ref<ResourceStats | null>(null)
const systemHealth = ref<SystemHealth | null>(null)
const statsLoading = ref(true)
const healthLoading = ref(true)
const kpiData = ref<KpiData | null>(null)
const kpiLoading = ref(true)
const trendData = ref<TrendPoint[]>([])
const trendLoading = ref(false)
const providerData = ref<ProviderUsageItem[]>([])
const providerLoading = ref(true)
const topUsersData = ref<TopUser[]>([])
const topUsersLoading = ref(true)
const metricsData = ref<SystemMetrics | null>(null)
const metricsLoading = ref(true)
const tokenData = ref<TokenStats | null>(null)
const tokenLoading = ref(true)
const eventsData = ref<SystemEventItem[]>([])
const eventsLoading = ref(true)
let eventPollTimer: ReturnType<typeof setInterval> | null = null

const chartRef = shallowRef<HTMLDivElement | null>(null)
const pieRef = shallowRef<HTMLDivElement | null>(null)
let chartInstance: echarts.ECharts | null = null
let pieInstance: echarts.ECharts | null = null

/* ---- Trend Data (API-driven) ---- */

const _providerColors = ['#10B981', '#8B5CF6', '#3B82F6', '#F59E0B', '#EC4899', '#6366F1']
const modelProviders = computed<ModelProvider[]>(() => {
  if (!providerData.value.length) return []
  return providerData.value.map((p, i) => ({
    name: p.name,
    models: p.models,
    color: _providerColors[i % _providerColors.length],
    icon: p.icon || '🤖',
    usage: p.usage_pct,
    popular: p.popular_model || '-',
  }))
})

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const topUsers = computed<TopUser[]>(() => {
  if (!topUsersData.value.length) return []
  return topUsersData.value.map(u => ({
    name: u.name,
    role: u.role,
    calls: u.calls,
    tokens: formatTokens(u.tokens),
    online: u.online,
  }))
})

const _eventIconMap: Record<string, typeof Bot> = {
  agent: Bot,
  tool: Zap,
  cron: Target,
  model: RefreshCw,
  mcp: Wrench,
  system: MessageSquare,
}

const recentEvents = computed<LogEvent[]>(() => {
  if (!eventsData.value.length) return []
  return eventsData.value.map(ev => ({
    time: ev.created_at ? new Date(ev.created_at).toLocaleTimeString('zh-CN', { hour12: false }) : '',
    type: ev.type as EventType,
    msg: ev.message,
    icon: _eventIconMap[ev.category] || Activity,
  }))
})

const systemMetrics = computed<SystemMetric[]>(() => {
  const m = metricsData.value
  if (!m) return []
  return [
    { label: 'API 响应时间', value: m.api_response_time.value, pct: m.api_response_time.pct, color: '#6366F1' },
    { label: 'CPU 使用率', value: m.cpu_usage.value, pct: m.cpu_usage.pct, color: '#10B981' },
    { label: '内存占用', value: m.memory_usage.value, pct: m.memory_usage.pct, color: '#8B5CF6' },
    { label: '磁盘使用率', value: m.disk_usage.value, pct: m.disk_usage.pct, color: '#F59E0B' },
    { label: '成功率', value: m.success_rate.value, pct: m.success_rate.pct, color: '#10B981' },
  ]
})

/* ---- Computed ---- */
const timeStr = computed(() =>
  currentTime.value.toLocaleTimeString('zh-CN', { hour12: false }),
)

const uptimeStr = computed(() => {
  const sec = systemHealth.value?.uptime_seconds ?? 0
  if (sec <= 0) return '--'
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
})

const systemStatusText = computed(() => {
  const s = systemHealth.value?.status
  if (!s) return '检测中...'
  if (s === 'ok') return '系统正常运行'
  return '系统状态异常'
})

const systemStatusOk = computed(() => systemHealth.value?.status === 'ok')

async function loadResourceStats() {
  statsLoading.value = true
  try {
    resourceStats.value = await fetchResourceStats()
  } catch (e) {
    console.error('Failed to load resource stats:', e)
  } finally {
    statsLoading.value = false
  }
}

async function loadSystemHealth() {
  healthLoading.value = true
  try {
    systemHealth.value = await fetchSystemHealth()
  } catch (e) {
    console.error('Failed to load system health:', e)
  } finally {
    healthLoading.value = false
  }
}

async function loadKpi() {
  kpiLoading.value = true
  try {
    kpiData.value = await fetchKpi(period.value)
  } catch (e) {
    console.error('Failed to load KPI:', e)
  } finally {
    kpiLoading.value = false
  }
}

async function loadTrendData() {
  trendLoading.value = true
  try {
    trendData.value = await fetchUsageTrend(period.value)
  } catch (e) {
    console.error('Failed to load trend data:', e)
  } finally {
    trendLoading.value = false
  }
}

async function loadProviderUsage() {
  providerLoading.value = true
  try {
    providerData.value = await fetchProviderUsage()
  } catch (e) {
    console.error('Failed to load provider usage:', e)
  } finally {
    providerLoading.value = false
  }
}

async function loadTopUsers() {
  topUsersLoading.value = true
  try {
    topUsersData.value = await fetchTopUsers(5, period.value)
  } catch (e) {
    console.error('Failed to load top users:', e)
  } finally {
    topUsersLoading.value = false
  }
}

async function loadSystemMetrics() {
  metricsLoading.value = true
  try {
    metricsData.value = await fetchSystemMetrics()
  } catch (e) {
    console.error('Failed to load system metrics:', e)
  } finally {
    metricsLoading.value = false
  }
}

async function loadTokenStats() {
  tokenLoading.value = true
  try {
    tokenData.value = await fetchTokenStats(period.value)
  } catch (e) {
    console.error('Failed to load token stats:', e)
  } finally {
    tokenLoading.value = false
  }
}

async function loadEvents() {
  eventsLoading.value = true
  try {
    eventsData.value = await fetchEvents(20)
  } catch (e) {
    console.error('Failed to load events:', e)
  } finally {
    eventsLoading.value = false
  }
}
const dateStr = computed(() =>
  currentTime.value.toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }),
)

const statCards = computed<StatCard[]>(() => [
  {
    label: '注册用户总数',
    value: kpiData.value ? kpiData.value.registered_users.toLocaleString() : '--',
    sub: `本期新增 +${kpiData.value?.new_users_this_period ?? 0}`,
    icon: Users, trend: 0, iconBg: 'indigo', borderColor: 'rgba(99,102,241,0.2)',
  },
  {
    label: '今日活跃用户',
    value: kpiData.value ? String(kpiData.value.active_users) : '--',
    sub: '',
    icon: Activity, trend: kpiData.value?.trend.active_users ?? 0,
    iconBg: 'purple', borderColor: 'rgba(139,92,246,0.2)',
  },
  {
    label: '今日总请求数',
    value: kpiData.value ? kpiData.value.total_requests.toLocaleString() : '--',
    sub: '',
    icon: BarChart3, trend: kpiData.value?.trend.requests ?? 0,
    iconBg: 'blue', borderColor: 'rgba(59,130,246,0.2)',
  },
  {
    label: '系统运行时长',
    value: uptimeStr.value,
    sub: '上次重启 ' + (systemHealth.value?.started_at?.slice(0, 10) || '--'),
    icon: Server, iconBg: 'emerald', borderColor: 'rgba(16,185,129,0.2)',
  },
])

const resourceItems = computed<ResourceItem[]>(() => {
  const s = resourceStats.value
  if (!s) return []
  return [
    { label: '总工具数', value: String(s.tools.total), icon: Wrench, color: '#F59E0B', borderColor: 'rgba(245,158,11,0.2)' },
    { label: '活跃技能', value: `${s.skills.enabled} / ${s.skills.total}`, icon: Zap, color: '#8B5CF6', borderColor: 'rgba(139,92,246,0.2)' },
    { label: '定时任务', value: String(s.cron_jobs.enabled), icon: Target, color: '#3B82F6', borderColor: 'rgba(59,130,246,0.2)' },
    { label: '主代理', value: String(s.agents.main), icon: Bot, color: '#6366F1', borderColor: 'rgba(99,102,241,0.2)' },
    { label: '子代理', value: String(s.agents.sub), icon: Layers, color: '#EC4899', borderColor: 'rgba(236,72,153,0.2)' },
    { label: 'MCP 服务', value: String(s.mcp_services.total), icon: Globe, color: '#10B981', borderColor: 'rgba(16,185,129,0.2)' },
  ]
})

/* ---- Chart Options ---- */
function makeAreaChartOptions(data: TrendPoint[]): echarts.EChartsOption {
  return {
    grid: { top: 8, right: 16, left: 40, bottom: 8 },
    xAxis: {
      type: 'category',
      data: data.map((d) => d.time),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#6B7280', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#1F2937', type: 'dashed' } },
      axisLabel: { color: '#6B7280', fontSize: 11 },
    },
    tooltip: {
      backgroundColor: '#111827',
      borderColor: '#374151',
      textStyle: { color: '#fff', fontSize: 12 },
    },
    series: [
      {
        name: '活跃用户',
        type: 'line',
        data: data.map((d) => d.users),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#6366F1', width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(99,102,241,0.5)' },
            { offset: 1, color: 'rgba(99,102,241,0)' },
          ]),
        },
      },
      {
        name: '请求数',
        type: 'line',
        data: data.map((d) => d.requests),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#8B5CF6', width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(139,92,246,0.4)' },
            { offset: 1, color: 'rgba(139,92,246,0)' },
          ]),
        },
      },
    ],
  }
}

function makePieChartOptions(): echarts.EChartsOption {
  const pieData = modelProviders.value.map((p) => ({ name: p.name, value: p.usage }))
  return {
    series: [
      {
        type: 'pie',
        radius: ['55%', '80%'],
        center: ['50%', '50%'],
        data: pieData,
        label: { show: false },
        emphasis: { scale: false },
        itemStyle: {
          borderColor: '#111827',
          borderWidth: 3,
        },
        color: modelProviders.value.map((p) => p.color),
      },
    ],
    tooltip: {
      backgroundColor: '#111827',
      borderColor: '#374151',
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: (params: { name: string; value: number }) =>
        `${params.name}: ${params.value}%`,
    },
  }
}

/* ---- Lifecycle ---- */
function initChart() {
  if (chartRef.value && !chartInstance) {
    chartInstance = echarts.init(chartRef.value)
    updateChart()
  }
  if (pieRef.value && !pieInstance) {
    pieInstance = echarts.init(pieRef.value)
    pieInstance.setOption(makePieChartOptions())
  }
}

function updateChart() {
  if (!chartInstance) return
  if (!trendData.value.length) return
  chartInstance.setOption(makeAreaChartOptions(trendData.value as unknown as { time: string; users: number; requests: number }[]), true)
}

function handleResize() {
  chartInstance?.resize()
  pieInstance?.resize()
}

watch(period, async () => {
  await loadTrendData()
  updateChart()
})

onMounted(async () => {
  clockTimer = setInterval(() => {
    currentTime.value = new Date()
  }, 1000)
  initChart()
  window.addEventListener('resize', handleResize)
  loadResourceStats()
  loadSystemHealth()
  loadKpi()
  await loadTrendData()
  updateChart()
  loadProviderUsage()
  loadTopUsers()
  loadSystemMetrics()
  loadTokenStats()
  loadEvents()
  // 每 10 秒轮询刷新事件日志
  eventPollTimer = setInterval(() => loadEvents(), 10000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  if (eventPollTimer) clearInterval(eventPollTimer)
  window.removeEventListener('resize', handleResize)
  chartInstance?.dispose()
  pieInstance?.dispose()
})

/* ---- Helpers ---- */
function formatLargeNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function eventColor(type: EventType): string {
  const map: Record<EventType, string> = {
    info: 'var(--color-accent)',
    success: '#10B981',
    warn: '#F59E0B',
    error: '#EF4444',
  }
  return map[type]
}

function eventBgColor(type: EventType): string {
  const map: Record<EventType, string> = {
    info: 'rgba(59,130,246,0.1)',
    success: 'rgba(16,185,129,0.1)',
    warn: 'rgba(245,158,11,0.1)',
    error: 'rgba(239,68,68,0.1)',
  }
  return map[type]
}

function eventDotColor(type: EventType): string {
  const map: Record<EventType, string> = {
    info: '#3B82F6',
    success: '#10B981',
    warn: '#F59E0B',
    error: '#EF4444',
  }
  return map[type]
}
</script>

<template>
  <div class="overview-page">
    <!-- ═══ Page Header ═══ -->
    <div class="page-header">
      <div class="header-left">
        <h1 class="page-title">概览</h1>
        <p class="page-subtitle">平台状态、用户洞察与资源分布</p>
      </div>
      <div class="header-right">
        <p class="header-time">{{ timeStr }}</p>
        <p class="header-date">{{ dateStr }}</p>
        <div class="header-status">
          <span class="status-dot" :class="{ 'status-error': !systemStatusOk }" />
          <span class="status-text" :class="{ 'status-error-text': !systemStatusOk }">{{ systemStatusText }}</span>
        </div>
      </div>
    </div>

    <!-- ═══ Top KPI Cards ═══ -->
    <div class="stat-grid">
      <div
        v-for="card in statCards"
        :key="card.label"
        class="stat-card"
        :style="{ borderColor: card.borderColor }"
      >
        <div class="stat-card-inner">
          <div class="stat-card-body">
            <span class="stat-label">{{ card.label }}</span>
            <span class="stat-value">{{ card.value }}</span>
            <span v-if="card.sub" class="stat-sub">{{ card.sub }}</span>
            <div v-if="card.trend !== undefined" class="stat-trend" :class="card.trend >= 0 ? 'up' : 'down'">
              <ArrowUpRight v-if="card.trend >= 0" :size="12" />
              <ArrowDownRight v-else :size="12" />
              {{ Math.abs(card.trend) }}% 较昨日
            </div>
          </div>
          <div class="stat-icon-wrap" :class="`icon-${card.iconBg}`">
            <component :is="card.icon" :size="20" />
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Resource Cards ═══ -->
    <div class="resource-grid">
      <div v-if="statsLoading" class="resource-card resource-loading" v-for="i in 6" :key="'r-skel-' + i">
        <div class="skeleton-icon"></div>
        <div class="skeleton-label"></div>
        <div class="skeleton-value"></div>
      </div>
      <div
        v-else
        v-for="item in resourceItems"
        :key="item.label"
        class="resource-card"
        :style="{ borderColor: item.borderColor }"
      >
        <component :is="item.icon" :size="20" :color="item.color" class="res-icon" />
        <span class="res-label">{{ item.label }}</span>
        <span class="res-value" :style="{ color: item.color }">{{ item.value }}</span>
      </div>
    </div>

    <!-- ═══ Usage Chart + Personnel ═══ -->
    <div class="chart-row">
      <!-- Chart -->
      <div class="chart-card chart-span-2">
        <div class="chart-card-header">
          <div>
            <h3 class="card-title">用户使用频次</h3>
            <p class="card-desc">活跃用户 & 请求数趋势</p>
          </div>
          <div class="period-tabs">
            <button
              v-for="p in (['day', 'month', 'year'] as Period[])"
              :key="p"
              class="period-tab"
              :class="{ active: period === p }"
              @click="period = p"
            >
              {{ p === 'day' ? '日' : p === 'month' ? '月' : '年' }}
            </button>
          </div>
        </div>
        <div ref="chartRef" class="chart-container"></div>
        <div class="chart-legend">
          <span class="legend-item">
            <span class="legend-line" style="background: #6366F1" />
            活跃用户
          </span>
          <span class="legend-item">
            <span class="legend-line" style="background: #8B5CF6" />
            请求数
          </span>
        </div>
      </div>

      <!-- Personnel -->
      <div class="chart-card">
        <h3 class="card-title">人员概况</h3>
        <p class="card-desc">按调用量排行</p>
        <div class="personnel-list">
          <div v-for="(u, i) in topUsers" :key="u.name" class="personnel-row">
            <span class="personnel-rank">{{ i + 1 }}</span>
            <div class="personnel-avatar">{{ u.name[0].toUpperCase() }}</div>
            <div class="personnel-info">
              <div class="personnel-name-row">
                <span class="personnel-name">{{ u.name }}</span>
                <span v-if="u.online" class="online-dot" />
              </div>
              <span class="personnel-role">{{ u.role }}</span>
            </div>
            <div class="personnel-stats">
              <span class="personnel-calls">{{ u.calls.toLocaleString() }} 次</span>
              <span class="personnel-tokens">{{ u.tokens }}</span>
            </div>
          </div>
        </div>
        <div class="personnel-summary">
          <div class="summary-item">
            <span class="summary-num">{{ kpiData?.personnel_summary?.total ?? 0 }}</span>
            <span class="summary-label">总成员</span>
          </div>
          <div class="summary-item">
            <span class="summary-num online">{{ kpiData?.personnel_summary?.online ?? 0 }}</span>
            <span class="summary-label">在线</span>
          </div>
          <div class="summary-item">
            <span class="summary-num admin">{{ kpiData?.personnel_summary?.admins ?? 0 }}</span>
            <span class="summary-label">管理员</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Model Providers + Token ═══ -->
    <div class="provider-row">
      <!-- Providers -->
      <div class="chart-card">
        <h3 class="card-title">模型提供商</h3>
        <p class="card-desc">
          共 {{ modelProviders.reduce((a, b) => a + b.models, 0) }} 个模型 ·
          {{ modelProviders.length }} 个提供商
        </p>
        <div class="provider-list">
          <div v-for="p in modelProviders" :key="p.name" class="provider-item">
            <span class="provider-icon">{{ p.icon }}</span>
            <div class="provider-meta">
              <div class="provider-top">
                <span class="provider-name">{{ p.name }}</span>
                <span class="provider-models">{{ p.models }} 个模型</span>
              </div>
              <div class="provider-bar-track">
                <div
                  class="provider-bar-fill"
                  :style="{ width: `${p.usage}%`, background: p.color }"
                />
              </div>
              <div class="provider-bottom">
                <span class="provider-popular">热门: {{ p.popular }}</span>
                <span class="provider-usage" :style="{ color: p.color }">{{ p.usage }}% 使用率</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pie + Token -->
      <div class="chart-card">
        <h3 class="card-title">使用分布</h3>
        <p class="card-desc">各提供商调用占比</p>
        <div class="pie-section">
          <div ref="pieRef" class="pie-container"></div>
          <div class="pie-legend">
            <div v-for="p in modelProviders" :key="p.name" class="pie-legend-item">
              <span class="pie-dot" :style="{ background: p.color }" />
              <span class="pie-name">{{ p.name }}</span>
              <span class="pie-pct">{{ p.usage }}%</span>
            </div>
          </div>
        </div>
        <div class="token-bar">
          <div class="token-item">
            <span class="token-label">今日 Token 消耗</span>
            <span class="token-value">{{ formatLargeNum(tokenData?.today_total ?? 0) }}</span>
          </div>
          <div class="token-item">
            <span class="token-label">周期累计</span>
            <span class="token-value accent">{{ formatLargeNum(tokenData?.period_total ?? 0) }}</span>
          </div>
          <div class="token-icon">
            <TrendingUp :size="18" />
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ System Health + Event Log ═══ -->
    <div class="bottom-row">
      <!-- System Health -->
      <div class="chart-card">
        <h3 class="card-title">系统健康</h3>
        <div class="health-list">
          <div v-for="m in systemMetrics" :key="m.label" class="health-item">
            <div class="health-top">
              <span class="health-label">{{ m.label }}</span>
              <span class="health-value">{{ m.value }}</span>
            </div>
            <div class="health-bar-track">
              <div
                class="health-bar-fill"
                :style="{ width: `${m.pct}%`, background: m.color }"
              />
            </div>
          </div>
        </div>
        <div class="health-status">
          <Shield :size="16" />
          <span>所有核心服务运行正常</span>
        </div>
      </div>

      <!-- Event Log -->
      <div class="chart-card event-log-card">
        <div class="chart-card-header">
          <div class="event-title-row">
            <h3 class="card-title">实时事件日志</h3>
            <span class="live-badge">
              <span class="live-dot" />
              LIVE
            </span>
          </div>
          <span class="event-count">{{ recentEvents.length }} 条最新事件</span>
        </div>
        <div class="event-list">
          <div
            v-for="(ev, i) in recentEvents"
            :key="i"
            class="event-row"
            :style="{ background: eventBgColor(ev.type) }"
          >
            <span class="event-dot" :style="{ background: eventDotColor(ev.type) }" />
            <component :is="ev.icon" :size="14" :color="eventDotColor(ev.type)" class="event-icon" />
            <span class="event-msg" :style="{ color: eventDotColor(ev.type) }">{{ ev.msg }}</span>
            <span class="event-time">{{ ev.time }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview-page {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
  background: var(--surface-primary);
}

/* ---- Page Header ---- */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  background: linear-gradient(90deg, #818CF8, #A78BFA, #60A5FA);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.page-subtitle {
  margin-top: 4px;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.header-right {
  text-align: right;
}

.header-time {
  font-size: 20px;
  font-family: 'Courier New', monospace;
  font-weight: 600;
  color: #A5B4FC;
}

.header-date {
  margin-top: 2px;
  font-size: 11px;
  color: var(--foreground-muted);
}

.header-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10B981;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 11px;
  color: #10B981;
}

.status-dot.status-error {
  background: #EF4444;
}

.status-error-text {
  color: #EF4444 !important;
}

/* ---- KPI Cards ---- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--surface-card);
  border: 1px solid;
  border-radius: var(--radius-xl);
  padding: 20px;
  position: relative;
  overflow: hidden;
}

.stat-card::before {
  content: '';
  position: absolute;
  top: -24px;
  right: -24px;
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(129, 140, 248, 0.2), transparent);
  pointer-events: none;
}

.stat-card-inner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  position: relative;
}

.stat-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--foreground-primary);
}

.stat-sub {
  font-size: 11px;
  color: #596680;
}

.stat-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.stat-trend.up { color: #10B981; }
.stat-trend.down { color: #EF4444; }

/* ---- Loading Skeletons ---- */
.resource-loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  animation: shimmer 1.5s infinite;
}

.skeleton-label {
  width: 60px;
  height: 12px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  animation: shimmer 1.5s infinite;
}

.skeleton-value {
  width: 40px;
  height: 20px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { opacity: 0.3; }
  50% { opacity: 0.6; }
  100% { opacity: 0.3; }
}

.stat-icon-wrap {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.icon-indigo { background: #4F46E5; }
.icon-purple { background: #7C3AED; }
.icon-blue { background: #2563EB; }
.icon-emerald { background: #059669; }

/* ---- Resource Cards ---- */
.resource-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.resource-card {
  background: var(--surface-card);
  border: 1px solid;
  border-radius: var(--radius-xl);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.res-icon {
  flex-shrink: 0;
}

.res-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.res-value {
  font-size: 20px;
  font-weight: 700;
}

/* ---- Chart Row ---- */
.chart-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

.chart-span-2 {
  /* handled by grid column */
}

.chart-card {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 20px;
}

.chart-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.card-title {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--foreground-primary);
}

.card-desc {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
  margin-top: 4px;
}

.period-tabs {
  display: flex;
  gap: 2px;
  background: rgba(255,255,255,0.04);
  padding: 3px;
  border-radius: var(--radius-lg);
}

.period-tab {
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  border: none;
  background: none;
  color: var(--foreground-muted);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.period-tab:hover { color: var(--foreground-primary); }

.period-tab.active {
  background: #4F46E5;
  color: #fff;
}

.chart-container {
  width: 100%;
  height: 220px;
}

.chart-legend {
  display: flex;
  gap: 16px;
  margin-top: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.legend-line {
  display: inline-block;
  width: 16px;
  height: 2px;
  border-radius: 1px;
}

/* ---- Personnel ---- */
.personnel-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.personnel-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.personnel-rank {
  width: 16px;
  font-size: var(--font-size-xs);
  color: #596680;
  text-align: center;
  flex-shrink: 0;
}

.personnel-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6366F1, #8B5CF6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.personnel-info {
  flex: 1;
  min-width: 0;
}

.personnel-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.personnel-name {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.online-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10B981;
  flex-shrink: 0;
}

.personnel-role {
  font-size: 11px;
  color: var(--foreground-muted);
}

.personnel-stats {
  text-align: right;
  flex-shrink: 0;
}

.personnel-calls {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: #A5B4FC;
  display: block;
}

.personnel-tokens {
  font-size: 11px;
  color: var(--foreground-muted);
}

.personnel-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 16px;
  padding: 12px;
  background: rgba(255,255,255,0.03);
  border-radius: var(--radius-lg);
}

.summary-item {
  text-align: center;
}

.summary-num {
  font-size: var(--font-size-md);
  font-weight: 700;
  color: var(--foreground-primary);
  display: block;
}

.summary-num.online { color: #10B981; }
.summary-num.admin { color: #A5B4FC; }

.summary-label {
  font-size: 11px;
  color: var(--foreground-muted);
}

/* ---- Provider Row ---- */
.provider-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.provider-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.provider-icon { font-size: 18px; flex-shrink: 0; }

.provider-meta { flex: 1; min-width: 0; }

.provider-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.provider-name {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.provider-models {
  font-size: 11px;
  color: var(--foreground-muted);
}

.provider-bar-track {
  height: 6px;
  background: rgba(255,255,255,0.06);
  border-radius: 3px;
  overflow: hidden;
}

.provider-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.7s ease;
}

.provider-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
}

.provider-popular { font-size: 10px; color: #596680; }

.provider-usage {
  font-size: 10px;
  font-weight: 500;
}

/* ---- Pie Section ---- */
.pie-section {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 8px;
}

.pie-container {
  width: 180px;
  height: 180px;
  flex-shrink: 0;
}

.pie-legend {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pie-legend-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pie-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pie-name {
  flex: 1;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  margin-left: 8px;
}

.pie-pct {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--foreground-primary);
}

.token-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-top: 12px;
  padding: 12px 16px;
  background: linear-gradient(90deg, rgba(79,70,229,0.15), rgba(139,92,246,0.15));
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: var(--radius-xl);
}

.token-item {
  display: flex;
  flex-direction: column;
}

.token-label {
  font-size: 11px;
  color: var(--foreground-muted);
}

.token-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground-primary);
  margin-top: 2px;
}

.token-value.accent { color: #A5B4FC; }

.token-icon {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: rgba(79,70,229,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #A5B4FC;
  margin-left: auto;
}

/* ---- Bottom Row ---- */
.bottom-row {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
}

/* ---- Health ---- */
.health-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.health-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.health-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.health-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.health-value {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--foreground-primary);
}

.health-bar-track {
  height: 6px;
  background: rgba(255,255,255,0.06);
  border-radius: 3px;
  overflow: hidden;
}

.health-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.7s ease;
}

.health-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 8px 12px;
  background: rgba(16,185,129,0.08);
  border: 1px solid rgba(16,185,129,0.2);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-xs);
  color: #10B981;
}

/* ---- Event Log ---- */
.event-log-card .chart-card-header {
  margin-bottom: 12px;
}

.event-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.live-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(79,70,229,0.2);
  border-radius: var(--radius-full);
  font-size: 10px;
  font-weight: 600;
  color: #A5B4FC;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #A5B4FC;
  animation: pulse 2s infinite;
}

.event-count {
  font-size: 11px;
  color: #596680;
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
  padding-right: 4px;
}

.event-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
}

.event-icon { flex-shrink: 0; }

.event-msg {
  flex: 1;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.event-time {
  font-size: 11px;
  font-family: 'Courier New', monospace;
  color: #596680;
  flex-shrink: 0;
}

/* ---- Responsive ---- */
@media (max-width: 1400px) {
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .resource-grid { grid-template-columns: repeat(3, 1fr); }
  .chart-row { grid-template-columns: 1fr; }
  .provider-row { grid-template-columns: 1fr; }
  .bottom-row { grid-template-columns: 1fr; }
}
</style>
