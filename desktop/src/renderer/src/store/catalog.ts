import { defineStore } from 'pinia'
import { computed, nextTick, reactive, ref } from 'vue'
import type { DesktopSkill } from '../../../preload/index.d'

/**
 * 目录数据与「+」菜单状态管理（渲染层）
 * 数据源与"智能体"下的 ExpertPage / SkillPage / ConnectorPage 共用；选择类状态（技能除外）经 localStorage 持久化
 */

export type Mode = 'default' | 'local' | 'knowledge'
export type CatalogTab = 'expert' | 'skill' | 'connector'

export interface Expert {
  id: string
  name: string
  title: string
  tags: string[]
  desc: string
  color: string
  icon: string
  category: string
  rating: number
  users: string
  initials: string
  systemPrompt: string
  tools: string[]
  providerId: string | null
  modelId: string | null
  modelName?: string | null
  modelType?: string | null
  skills?: unknown[]
  mcpConfigs?: unknown[]
  promptTemplate: string
  expertiseAreas: string[]
  isExpert: boolean
}

export interface SkillItem extends DesktopSkill {
  /** 当前静态技能广场展示的使用量文案；Web 同步后可选 */
  count?: string
}

export interface ConnectorItem {
  id: number
  name: string
  desc: string
  color: string
  connected: boolean
  /** 外部授权页面地址（点击连接器右侧 + 时在系统浏览器打开） */
  authUrl: string
}

/** 本地文件（专家/技能/连接器页数据同源，此处唯一声明，相关页面引用） */
export const experts = ref<Expert[]>([])

export const skillItems = ref<SkillItem[]>([])

export const connectorItems = reactive<ConnectorItem[]>([
  {
    id: 1,
    name: 'GitHub',
    desc: '同步仓库、PR、Issue，代码直接入上下文',
    color: 'linear-gradient(135deg,#1f2937,#374151)',
    connected: true,
    authUrl: 'https://github.com/login'
  },
  {
    id: 2,
    name: 'Notion',
    desc: '读写 Notion 页面与数据库，知识无缝流动',
    color: 'linear-gradient(135deg,#1a1a1a,#333)',
    connected: false,
    authUrl: 'https://www.notion.so/login'
  },
  {
    id: 3,
    name: '飞书',
    desc: '同步飞书文档、多维表格与日历事件',
    color: 'linear-gradient(135deg,#2f6fe5,#1652c4)',
    connected: true,
    authUrl: 'https://open.feishu.cn/app'
  },
  {
    id: 4,
    name: '钉钉',
    desc: '同步钉钉审批、文档与工作群消息',
    color: 'linear-gradient(135deg,#2489ff,#0067e6)',
    connected: false,
    authUrl: 'https://open.dingtalk.com/'
  },
  {
    id: 5,
    name: '数据库',
    desc: '直连 MySQL / PostgreSQL，自然语言查询',
    color: 'linear-gradient(135deg,#f59e0b,#d97706)',
    connected: false,
    authUrl: 'https://www.postgresql.org/'
  },
  {
    id: 6,
    name: 'Slack',
    desc: '发送消息、查看频道，团队协作更顺畅',
    color: 'linear-gradient(135deg,#4a154b,#611f69)',
    connected: false,
    authUrl: 'https://slack.com/signin'
  },
  {
    id: 7,
    name: 'Google Drive',
    desc: '读取与创建 Google Docs / Sheets / Slides',
    color: 'linear-gradient(135deg,#34a853,#1e8e3e)',
    connected: false,
    authUrl: 'https://accounts.google.com/v3/signin/identifier'
  }
])

const STORAGE_KEY = 'ke-work:task-selection'

interface PersistedState {
  mode: Mode
  selectedExpertId: string | null
  selectedExpertPrompt: string
  recentExpertIds: string[]
}

const DEFAULT_STATE: PersistedState = {
  mode: 'default',
  selectedExpertId: null,
  selectedExpertPrompt: '',
  recentExpertIds: []
}

/** node 测试环境/localStorage 不可用时不抛错 */
function readStorage(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStorage(state: PersistedState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储满/被禁用：静默忽略，仅本次会话有效
  }
}

/** 懒加载持久化状态；坏 JSON/结构不合法 → 回退默认值（字段级校验） */
function loadPersisted(): PersistedState {
  const raw = readStorage()
  if (!raw) return { ...DEFAULT_STATE }
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return { ...DEFAULT_STATE }
    const d = data as Record<string, unknown>
    const out: PersistedState = { ...DEFAULT_STATE }
    if (d.mode === 'default' || d.mode === 'local' || d.mode === 'knowledge') out.mode = d.mode
    if (typeof d.selectedExpertId === 'string' || typeof d.selectedExpertId === 'number') {
      out.selectedExpertId = String(d.selectedExpertId)
    } else if (d.selectedExpertId === null) {
      out.selectedExpertId = null
    }
    if (typeof d.selectedExpertPrompt === 'string')
      out.selectedExpertPrompt = d.selectedExpertPrompt
    if (Array.isArray(d.recentExpertIds)) {
      out.recentExpertIds = d.recentExpertIds
        .filter((n): n is string | number => typeof n === 'string' || typeof n === 'number')
        .map((n) => String(n))
        .slice(0, 5)
    }
    return out
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** 专家使用提示词模板（插入输入框的可编辑文本，删除专家时按原文移除） */
function buildExpertPrompt(expert: Expert): string {
  const template = expert.promptTemplate || '请先分析任务并拆分为子任务；对于适合【{name}·{title}】处理的子任务，请调用该专家处理；最后汇总结果。'
  return template.replace('{name}', expert.name).replace('{title}', expert.title)
}

export const useCatalogStore = defineStore('catalog', () => {
  // ====== 状态(State) ======
  /** 智能体下专家 / 技能 / 连接器页的目标标签页（PlusMenu 导航目标） */
  const pageTab = ref<CatalogTab>('expert')
  /** 任务模式（互斥）：default=默认 / local=本地文件 / knowledge=知识库 */
  const mode = ref<Mode>(loadPersisted().mode)
  const selectedExpertId = ref<string | null>(loadPersisted().selectedExpertId)
  /** 插入输入框的专家提示词原文（切换/删除专家时用于移除） */
  const selectedExpertPrompt = ref<string>(loadPersisted().selectedExpertPrompt)
  /** 已选技能 id（选择顺序即展示顺序；不持久化，随输入框会话状态） */
  const selectedSkillIds = ref<string[]>([])
  /** 最近使用专家 id（最近在前，上限 5） */
  const recentExpertIds = ref<string[]>(loadPersisted().recentExpertIds)
  /** 连接器定位目标（一次性：跳转后高亮对应授权连接卡片） */
  const focusConnectorId = ref<number | null>(null)

  // ====== 计算属性(Getters) ======
  const selectedExpert = computed(
    () => experts.value.find((e) => e.id === selectedExpertId.value) ?? null
  )
  const selectedSkills = computed(() =>
    selectedSkillIds.value
      .map((id) => skillItems.value.find((s) => s.id === id))
      .filter((s): s is SkillItem => !!s)
  )
  const recentExperts = computed(() =>
    recentExpertIds.value
      .map((id) => experts.value.find((e) => e.id === id))
      .filter((e): e is Expert => !!e)
  )
  /** 已授权连接器（授权通过后才会出现在「+」菜单的连接器二级菜单） */
  const availableConnectors = computed(() => connectorItems.filter((c) => c.connected))

  // ====== 持久化 ======
  function persist(): void {
    writeStorage({
      mode: mode.value,
      selectedExpertId: selectedExpertId.value,
      selectedExpertPrompt: selectedExpertPrompt.value,
      recentExpertIds: [...recentExpertIds.value]
    })
  }

  // ====== 方法(Actions) ======

  /** 设置任务模式（radio：打开一个自动关闭其余；点当前项无操作） */
  function setMode(m: Mode): void {
    if (mode.value === m) return
    mode.value = m
    persist()
  }

  /** 记录专家使用（去重置顶、上限 5） */
  function recordExpertUse(id: string): void {
    recentExpertIds.value = [id, ...recentExpertIds.value.filter((x) => x !== id)].slice(0, 5)
    persist()
  }

  /** 选择专家（单选；生成提示词并记入最近使用） */
  function setExpert(id: string): void {
    const expert = experts.value.find((e) => e.id === id)
    if (!expert) return
    selectedExpertId.value = id
    selectedExpertPrompt.value = buildExpertPrompt(expert)
    recordExpertUse(id)
  }

  /** 取消专家选择（提示词由页面从输入框移除） */
  function clearExpert(): void {
    selectedExpertId.value = null
    selectedExpertPrompt.value = ''
    persist()
  }

  /** 技能多选切换（不持久化，随输入框会话状态） */
  function toggleSkill(id: string): void {
    const idx = selectedSkillIds.value.indexOf(id)
    if (idx === -1) {
      selectedSkillIds.value = [...selectedSkillIds.value, id]
    } else {
      selectedSkillIds.value = selectedSkillIds.value.filter((x) => x !== id)
    }
  }

  /** 清空全部技能（发送时调用） */
  function clearSkills(): void {
    selectedSkillIds.value = []
  }

  /** 用 Web 同步结果替换技能广场数据。 */
  function setSkills(skills: SkillItem[]): void {
    skillItems.value = skills
  }

  /** 用 Web 同步结果替换专家数据。 */
  function setExperts(items: Expert[]): void {
    experts.value = items
  }

  /** 清空服务器专家数据（断开连接或退出登录时使用）。 */
  function clearExpertItems(): void {
    experts.value = []
  }

  /** 清空服务器技能数据（断开连接或退出登录时使用）。 */
  function clearSkillItems(): void {
    skillItems.value = []
  }

  /** 跳转到智能体下某个标签页 */
  function gotoTab(tab: CatalogTab): void {
    pageTab.value = tab
  }

  /** 连接器授权通过后标记为可用 */
  function authorizeConnector(id: number): void {
    const connector = connectorItems.find((c) => c.id === id)
    if (connector) connector.connected = true
  }

  /**
   * 跳转到连接器标签页并定位到指定连接器的授权连接卡片
   * 先清空再写入（nextTick 后），保证连续点击同一连接器也能触发 ExpertPage 的 watch
   */
  function gotoConnector(id: number): void {
    pageTab.value = 'connector'
    focusConnectorId.value = null
    nextTick(() => {
      focusConnectorId.value = id
    })
  }

  return {
    // 数据
    experts,
    skillItems,
    connectorItems,
    // 状态
    pageTab,
    mode,
    selectedExpertId,
    selectedExpertPrompt,
    selectedSkillIds,
    recentExpertIds,
    focusConnectorId,
    // 计算
    selectedExpert,
    selectedSkills,
    recentExperts,
    availableConnectors,
    // 方法
    setMode,
    recordExpertUse,
    setExpert,
    clearExpert,
    toggleSkill,
    clearSkills,
    setSkills,
    clearSkillItems,
    setExperts,
    clearExpertItems,
    gotoTab,
    gotoConnector,
    authorizeConnector
  }
})
