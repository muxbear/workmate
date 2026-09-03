import http from '@/services/request'

export interface CountPair {
  total: number
  enabled: number
}

export interface AgentCount {
  main: number
  sub: number
}

export interface ResourceStats {
  tools: CountPair
  skills: CountPair
  cron_jobs: CountPair
  agents: AgentCount
  mcp_services: CountPair
  personnel: CountPair
  providers: CountPair
  models: CountPair
  system_status: string
}

export interface HealthCheck {
  name: string
  status: string
}

export interface SystemHealth {
  status: string
  uptime_seconds: number
  started_at: string
  db_connected: boolean
  checks: HealthCheck[]
}

export async function fetchResourceStats() {
  const res = await http.get('/overview/resource-stats')
  return res.data.data as ResourceStats
}

export async function fetchSystemHealth() {
  const res = await http.get('/overview/health')
  return res.data.data as SystemHealth
}

export interface PersonnelSummary {
  total: number
  online: number
  admins: number
}

export interface KpiData {
  registered_users: number
  active_users: number
  total_requests: number
  new_users_this_period: number
  trend: {
    active_users: number
    requests: number
  }
  personnel_summary: PersonnelSummary
}

export interface TrendPoint {
  time: string
  users: number
  requests: number
}

export interface ProviderUsageItem {
  name: string
  icon: string
  models: number
  usage_pct: number
  call_count: number
  token_total: number
  popular_model: string
  connected: boolean
}

export interface TopUser {
  name: string
  role: string
  calls: number
  tokens: number
  online: boolean
}

export async function fetchKpi(period: string = 'day') {
  const res = await http.get('/overview/kpi', { params: { period } })
  return res.data.data as KpiData
}

export async function fetchUsageTrend(period: string = 'day') {
  const res = await http.get('/overview/usage-trend', { params: { period } })
  return res.data.data as TrendPoint[]
}

export async function fetchProviderUsage() {
  const res = await http.get('/overview/provider-usage')
  return res.data.data as ProviderUsageItem[]
}

export async function fetchTopUsers(limit: number = 5, period: string = 'day') {
  const res = await http.get('/overview/top-users', { params: { limit, period } })
  return res.data.data as TopUser[]
}

export interface MetricItem {
  value: string
  pct: number
}

export interface SystemMetrics {
  api_response_time: MetricItem
  cpu_usage: MetricItem
  memory_usage: MetricItem
  disk_usage: MetricItem
  success_rate: MetricItem
}

export interface TokenProviderItem {
  name: string
  tokens: number
  pct: number
}

export interface TokenStats {
  today_total: number
  period_total: number
  by_provider: TokenProviderItem[]
}

export interface SystemEventItem {
  id: string
  type: string
  category: string
  message: string
  created_at: string
}

export async function fetchSystemMetrics() {
  const res = await http.get('/overview/system-metrics')
  return res.data.data as SystemMetrics
}

export async function fetchTokenStats(period: string = 'day') {
  const res = await http.get('/overview/token-stats', { params: { period } })
  return res.data.data as TokenStats
}

export async function fetchEvents(limit: number = 20) {
  const res = await http.get('/overview/events', { params: { limit } })
  return res.data.data as SystemEventItem[]
}
