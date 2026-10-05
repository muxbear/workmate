<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast as showToastBase } from '@renderer/composables/useToast'
import { useConversationSearch } from '@renderer/composables/useConversationSearch'
import { useSharePanel } from '@renderer/composables/useSharePanel'
import { copyText } from '@renderer/composables/clipboard'
import { useAgentStore } from '@store/agent'
import { useModelStore } from '@store/models'
import MessageList from '@components/MessageList.vue'
import ShareDialog from '@components/ShareDialog.vue'
import ChatSidePanel from '@components/ChatSidePanel.vue'
import PromptInput, { type PromptPayload } from '@components/PromptInput.vue'
import { useCatalogStore, type CatalogTab } from '@store/catalog'
import { loadQuickChips, saveQuickChips } from '@store/quickChips'
import { useSettingsStore } from '@store/settings'

const agentStore = useAgentStore()
const catalog = useCatalogStore()
const modelStore = useModelStore()
const settingsStore = useSettingsStore()
type CatalogNavTarget = '专家' | '技能' | '连接器'
const emit = defineEmits<{ navigate: [tab: CatalogNavTarget] }>()

const CATALOG_NAV_TARGETS: Record<CatalogTab, CatalogNavTarget> = {
  expert: '专家',
  skill: '技能',
  connector: '连接器'
}

// 通过本地 computed 包装 agentStore，建立正确的 Vue 响应式依赖链
const currentMessages = computed(() => agentStore.currentMessages)
const isStreaming = computed(() => agentStore.isStreaming)

// ── State ──
const category = ref('work')
const taskInput = ref('')
const model = ref('Auto')
const chipsScrollRef = ref<HTMLElement | null>(null)
/** 输入卡组件实例（欢迎态 / 对话态互斥挂载，共用一个 ref） */
const promptRef = ref<InstanceType<typeof PromptInput> | null>(null)
/** 消息列表组件实例（滚动机制随 R6 外提；本页仅做布局联动与强制跟随） */
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)

/** 菜单内导航 → Home 切换到“智能体”下对应的专家 / 技能 / 连接器页面 */
const onPlusNavigate = (tab: CatalogTab): void => {
  emit('navigate', CATALOG_NAV_TARGETS[tab])
}

// ── Chat 态右侧栏 ──
const panelFullscreen = ref(false)

// 右侧栏全屏切换：.chat-main 以 v-show 隐藏会重置 scrollTop，恢复后刷新滚动状态（防按钮/追滚读陈旧值）
watch(panelFullscreen, () => {
  // 全屏右侧栏时退出 5:5 比例态（全屏宽度 100%）
  if (panelFullscreen.value) sideRatioMode.value = false
  messageListRef.value?.refreshScrollState()
})

// 轻量提示：全局 toast（本页沿用历史 1.5s 短时长；欢迎态/对话态由全局宿主统一覆盖）
const showToast = (text: string): void => showToastBase(text, 1500)

// ── 文档右侧栏：5:5 比例态 ──
// 产物流本身由 ChatSidePanel 直接订阅 store.liveArtifact（单一事实源）；
// 本页只对「新产物出现」做布局反应（进入 5:5），不再搬运内容。
const sidePanelRef = ref<InstanceType<typeof ChatSidePanel> | null>(null)
const sideRatioMode = ref(false)

/** 新产物出现（artifactId 变化）→ 进入 5:5 比例态 */
watch(
  () => agentStore.liveArtifact?.artifactId,
  (id, prev) => {
    if (id && id !== prev) sideRatioMode.value = true
  }
)

watch(
  () => agentStore.currentConversationId,
  () => {
    sideRatioMode.value = false
  }
)

/** 点击消息区文档文件卡片/正文链接 → 右侧打开（未开则展开，已开则聚焦；R6：由 MessageList 统一 emit） */
async function openDocFromList(relPath: string, name?: string): Promise<void> {
  sideRatioMode.value = true
  const displayName = name ?? relPath.split('/').pop() ?? relPath
  await sidePanelRef.value?.openDocFileByRelPath(relPath, { name: displayName })
}

// ── 消息操作栏（点赞/朗读/复制：R6 外提至 components/MessageActions.vue，per-instance 状态）──

// ── 格式化工具 ──
const formatTime = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── 历史提问下拉 ──
const historyMenuOpen = ref(false)
const historyQuestions = computed(() =>
  messages.value
    .filter((m) => m.role === 'user')
    .slice()
    .reverse()
)

/** 重新生成最后一条回复 */
const regenerateLast = (): void => {
  // 用户主动触发的消息动作：即使向上翻阅过也强制回到底部跟随
  messageListRef.value?.stickToBottom()
  agentStore.regenerate({
    model: model.value,
    customModelId: selectedCustomId.value ?? undefined,
    backendKind: CATEGORY_BACKEND[category.value] ?? 'filesystem'
  })
}

// ── Computed ──
const messages = computed(() => {
  return currentMessages.value.map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    reasoning: m.reasoning,
    createdAt: m.createdAt,
    durationMs: m.durationMs,
    model: m.model,
    files: m.files
  }))
})

// ── 对话内搜索（R6 外提至 composables/useConversationSearch；suppressAutoScroll 由下方滚动 watcher 读取） ──
const {
  searchOpen,
  searchKeyword,
  searchIndex,
  suppressAutoScroll,
  closeSearch,
  searchMatches,
  hitSet,
  currentHitId,
  scrollToMsg,
  gotoSearch
} = useConversationSearch({ messages })

/** 从历史问题菜单跳转（先收起菜单再定位） */
const jumpToQuestion = (id: string): void => {
  historyMenuOpen.value = false
  scrollToMsg(id)
}

// ── 分享选择模式 + 二维码（R6 外提至 composables/useSharePanel；与搜索互斥、复制能力与消息操作共用） ──
const {
  shareMode,
  shareSelected,
  shareAllChecked,
  shareAllIndeterminate,
  isShareSelected,
  toggleShareSelected,
  toggleShareAll,
  openSharePanel,
  closeSharePanel,
  shareLink,
  shareToWechat,
  shareToMoments,
  copyShareLink,
  openShareInBrowser,
  qrModalOpen,
  qrDataUrl,
  generateQr,
  closeQrModal
} = useSharePanel({
  messages,
  conversationId: computed(() => agentStore.currentConversationId),
  onBeforeOpen: closeSearch,
  notify: showToast,
  copy: copyText
})
// ── 思考块交互 / 委派计时 / 消息列表渲染：随 R6 外提至 ThinkingBlock 与 MessageList 组件 ──

// ── Constants ──
const categories = [
  { key: 'work', label: '日常办公', icon: '☀️' },
  { key: 'code', label: '代码开发', icon: '</>' }
]

/** 分类 → 主智能体 backend：日常办公=仅文件读写（无 shell），代码开发=文件读写 + 本地 shell */
const CATEGORY_BACKEND: Record<string, 'filesystem' | 'shell'> = {
  work: 'filesystem',
  code: 'shell'
}

/** 场景快捷入口 → 对应专家名（未登记的场景暂无专家可召唤） */
const QUICK_CHIP_EXPERTS: Record<string, string> = {
  视频生成: '视频创作专家',
  文档处理: '文档写作专家',
  深度研究: '互联网信息检索专家'
}

/** 场景 chip 清单：来自本地配置（默认清单见 store/quickChips），用户删掉的落盘后不再出现 */
const quickChips = ref(loadQuickChips())

/** chip 高亮 = 它对应的专家正是当前选中的那个（没选中任何专家时都不高亮） */
function isChipSelected(label: string): boolean {
  const expertName = QUICK_CHIP_EXPERTS[label]
  if (!expertName) return false
  const expert = catalog.experts.find((item) => item.name === expertName)
  return !!expert && catalog.selectedExpertId === expert.id
}

/** 从本地配置里删掉一个 chip（落盘；删完不再显示） */
function removeQuickChip(label: string): void {
  quickChips.value = quickChips.value.filter((chip) => chip.label !== label)
  saveQuickChips(quickChips.value)
  showToast(`已移除「${label}」`)
  nextTick(updateChipsScrollState)
}

/**
 * 场景快捷入口：直接选中对应专家（与「+」菜单同一条路径：选中 + 插入委派提示词）。
 *
 * 这些 chip 以前没有任何点击行为（点了没反应）；没有对应专家的场景给出明确提示，
 * 而不是静默无响应。
 */
function applyQuickChip(label: string): void {
  const expertName = QUICK_CHIP_EXPERTS[label]
  if (!expertName) {
    showToast(`「${label}」暂未配置对应专家`)
    return
  }
  const expert = catalog.experts.find((item) => item.name === expertName)
  if (!expert) {
    showToast(`未找到「${expertName}」，请先到「智能体 → 专家」同步专家`)
    return
  }
  catalog.setExpert(expert.id)
  showToast(`已添加「${expertName}」`)
}

/** 当前选中的自定义模型 id（发送/重新生成时随 customModelId 传主进程；内置模型为 null） */
const selectedCustomId = ref<string | null>(null)

// ── chip 行横向滚动状态（滚动箭头只在对应方向"看不全"时出现）──
const chipsAtStart = ref(true)
const chipsAtEnd = ref(true)

/** 由容器 scroll / 尺寸变化驱动；1px 容差消化缩放取整 */
const updateChipsScrollState = (): void => {
  const el = chipsScrollRef.value
  if (!el) return
  chipsAtStart.value = el.scrollLeft <= 1
  chipsAtEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
}

/**
 * 欢迎态/对话态互斥挂载：容器出现时接上 ResizeObserver（首帧布局、窗口缩放都会回调），
 * 消失时断开——箭头不依赖 scroll 事件，没有滚动过也能算出正确可见性。
 */
let chipsResizeObserver: ResizeObserver | null = null
watch(chipsScrollRef, (el) => {
  chipsResizeObserver?.disconnect()
  chipsResizeObserver = null
  if (!el) return
  chipsResizeObserver = new ResizeObserver(updateChipsScrollState)
  chipsResizeObserver.observe(el)
  nextTick(updateChipsScrollState)
})

onUnmounted(() => chipsResizeObserver?.disconnect())

const scrollChips = (dir: 'left' | 'right'): void => {
  const el = chipsScrollRef.value
  if (!el) return
  el.scrollBy({ left: dir === 'right' ? 120 : -120, behavior: 'smooth' })
}

/** 失败回填：文本段与文件 token 一并写回输入卡（与自动化编辑回填同用 setParts；重试无需重选文件） */
const restorePromptText = (parts: PromptPayload['parts']): void => {
  promptRef.value?.setParts(parts)
  taskInput.value = parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** 发送消息：注入专家 → 调 agent → 清空输入卡（失败回填） */
const sendMessage = async (payload: PromptPayload): Promise<void> => {
  // 先将选中专家注入主智能体；无专家时清空子智能体，避免沿用上一条会话的专家配置。
  const expert = payload.expertId
    ? (catalog.experts.find((e) => e.id === payload.expertId) ?? null)
    : null

  // 提交即清空输入卡（正文 + token + 技能勾选，保留专家与模式选择）：
  // setExperts 可能因专家 MCP 加载耗时，不能等它再清（否则用户会以为没提交上而重复回车）
  promptRef.value?.clear()
  taskInput.value = ''

  try {
    const expertRes = await window.api.setExperts(
      expert ? [JSON.parse(JSON.stringify(expert))] : []
    )
    if (!expertRes.success) {
      showToast(expertRes.error || '设置专家失败')
      restorePromptText(payload.parts)
      return
    }
    // 专家依赖的 MCP 服务连不上时（例如视频生成服务不可达）明确提示，避免用户以为专家"坏了"
    const mcpWarnings = expertRes.data?.mcpWarnings ?? []
    if (mcpWarnings.length > 0) {
      console.warn('[NewTaskPage] 专家 MCP 服务加载失败:', mcpWarnings)
      const first = mcpWarnings[0]
      const suffix = mcpWarnings.length > 1 ? ` 等 ${mcpWarnings.length} 项` : ''
      showToast(`「${first.toolName}」未能连接${suffix}，该专家相关能力不可用`)
    }
  } catch (err) {
    console.error('[NewTaskPage] setExperts failed:', err)
    showToast(err instanceof Error ? err.message : '设置专家失败')
    restorePromptText(payload.parts)
    return
  }

  // 用户主动触发的消息动作：即使向上翻阅过也强制回到底部跟随
  messageListRef.value?.stickToBottom()
  agentStore
    .sendMessage(payload.parts, {
      model: payload.model,
      customModelId: payload.customModelId,
      backendKind: CATEGORY_BACKEND[category.value] ?? 'filesystem'
    })
    .catch((err: unknown) => {
      console.error('[NewTaskPage] sendMessage failed:', err)
      restorePromptText(payload.parts)
    })
}

// ── Close menus on outside click ──
const handleDocumentClick = (e: MouseEvent): void => {
  const target = e.target as HTMLElement
  // 「+」菜单 / 工作空间菜单 / 权限菜单由 PromptInput 组件内部处理，这里只管历史提问下拉
  if (!target.closest('[data-history-menu-trigger]') && !target.closest('.history-menu')) {
    historyMenuOpen.value = false
  }
}

let removeTitleErrorListener: (() => void) | null = null

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
  // 自定义模型列表（设置页新增后聊天页下拉同步刷新；失败静默保留旧值）
  void modelStore.load()
  // 标题总结失败时在对话态直接提示
  removeTitleErrorListener = window.api.onConversationTitleError(({ error }) => {
    showToast(error)
  })
})

onUnmounted(() => {
  removeTitleErrorListener?.()
  document.removeEventListener('mousedown', handleDocumentClick)
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  // 输入框随页面卸载：丢弃未发送草稿的技能勾选（发送路径已清空，此处兜底导航/重挂载）
  if (taskInput.value.trim()) catalog.clearSkills()
})

// ── 滚动状态机与历史回显滚底：随 R6 外提至 components/MessageList.vue ──
</script>

<template>
  <div class="new-task-page">
    <!-- Welcome state -->
    <div v-if="currentMessages.length === 0" class="welcome-area">
      <h2 class="welcome-heading">{{ settingsStore.systemName }}，<span class="welcome-highlight">我帮你</span></h2>

      <!-- Category pills -->
      <div class="category-pills">
        <button
          v-for="cat in categories"
          :key="cat.key"
          :class="['category-pill', { 'category-pill--active': category === cat.key }]"
          @click="category = cat.key"
        >
          <span>{{ cat.icon }}</span>
          {{ cat.label }}
        </button>
      </div>

      <!-- Quick chips + mascot -->
      <div class="chips-row">
        <button
          v-if="!chipsAtStart"
          class="chips-scroll-btn chips-scroll-btn--left"
          title="向前查看"
          @click="scrollChips('left')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div ref="chipsScrollRef" class="chips-scroll" @scroll="updateChipsScrollState">
          <div v-for="chip in quickChips" :key="chip.label" class="quick-chip-wrap">
            <button
              class="quick-chip"
              :class="{ 'quick-chip--active': isChipSelected(chip.label) }"
              @click="applyQuickChip(chip.label)"
            >
              <span class="chip-icon">
                <svg
                  v-if="chip.icon === 'doc'"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <svg
                  v-else-if="chip.icon === 'chart'"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
                <svg
                  v-else-if="chip.icon === 'research'"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
                <svg
                  v-else-if="chip.icon === 'video'"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" />
                </svg>
                <svg
                  v-else-if="chip.icon === 'slides'"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </span>
              {{ chip.label }}
            </button>
            <button
              class="quick-chip-del"
              :aria-label="`移除「${chip.label}」`"
              :title="`移除「${chip.label}」`"
              @click.stop="removeQuickChip(chip.label)"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <button
          v-if="!chipsAtEnd"
          class="chips-scroll-btn chips-scroll-btn--right"
          title="向后查看"
          @click="scrollChips('right')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        <!-- Robot mascot -->
        <svg class="mascot" width="72" height="72" viewBox="0 0 88 88" fill="none">
          <defs>
            <linearGradient id="rmg1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#e2e8f0" />
              <stop offset="100%" stop-color="#cbd5e1" />
            </linearGradient>
            <linearGradient id="rmg2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#0891b2" />
              <stop offset="100%" stop-color="#0e7490" />
            </linearGradient>
          </defs>
          <rect x="24" y="44" width="40" height="28" rx="10" fill="url(#rmg1)" />
          <rect x="32" y="52" width="24" height="14" rx="5" fill="url(#rmg2)" opacity="0.9" />
          <circle cx="38" cy="57" r="2" fill="#22d3ee" opacity="0.9" />
          <circle cx="44" cy="57" r="2" fill="#67e8f9" opacity="0.7" />
          <circle cx="50" cy="57" r="2" fill="#06b6d4" opacity="0.8" />
          <rect x="36" y="61" width="16" height="2" rx="1" fill="#cffafe" opacity="0.6" />
          <rect x="38" y="40" width="12" height="6" rx="3" fill="url(#rmg1)" />
          <rect x="18" y="14" width="52" height="28" rx="14" fill="url(#rmg1)" />
          <path d="M22 20 L16 8 L30 16Z" fill="#cbd5e1" />
          <path d="M66 20 L72 8 L58 16Z" fill="#cbd5e1" />
          <path d="M23 19 L19 11 L29 17Z" fill="#f1a1c0" opacity="0.5" />
          <path d="M65 19 L69 11 L59 17Z" fill="#f1a1c0" opacity="0.5" />
          <rect x="28" y="24" width="12" height="10" rx="5" fill="white" />
          <rect x="48" y="24" width="12" height="10" rx="5" fill="white" />
          <circle cx="34" cy="29" r="4" fill="#1e293b" />
          <circle cx="54" cy="29" r="4" fill="#1e293b" />
          <circle cx="35.5" cy="27.5" r="1.5" fill="white" />
          <circle cx="55.5" cy="27.5" r="1.5" fill="white" />
          <rect
            x="27"
            y="23"
            width="14"
            height="12"
            rx="6"
            fill="none"
            stroke="url(#rmg2)"
            stroke-width="1.5"
          />
          <rect
            x="47"
            y="23"
            width="14"
            height="12"
            rx="6"
            fill="none"
            stroke="url(#rmg2)"
            stroke-width="1.5"
          />
          <ellipse cx="44" cy="37" rx="3" ry="1.5" fill="#94a3b8" />
          <path
            d="M40 40 Q44 43 48 40"
            stroke="#94a3b8"
            stroke-width="1.2"
            stroke-linecap="round"
            fill="none"
          />
          <path
            d="M16 27 Q14 20 20 16"
            stroke="#0891b2"
            stroke-width="3"
            stroke-linecap="round"
            fill="none"
          />
          <rect x="12" y="26" width="8" height="10" rx="4" fill="url(#rmg2)" />
          <path
            d="M72 27 Q74 20 68 16"
            stroke="#0891b2"
            stroke-width="3"
            stroke-linecap="round"
            fill="none"
          />
          <rect x="68" y="26" width="8" height="10" rx="4" fill="url(#rmg2)" />
          <rect x="10" y="48" width="14" height="18" rx="7" fill="url(#rmg1)" />
          <rect x="64" y="48" width="14" height="18" rx="7" fill="url(#rmg1)" />
          <rect x="28" y="70" width="12" height="8" rx="4" fill="#cbd5e1" />
          <rect x="48" y="70" width="12" height="8" rx="4" fill="#cbd5e1" />
        </svg>
      </div>

      <!-- 输入卡（与「新建自动化」弹窗复用同一 PromptInput 组件） -->
      <PromptInput
        ref="promptRef"
        v-model:text="taskInput"
        v-model:model="model"
        v-model:custom-model-id="selectedCustomId"
        placeholder="今天帮你做些什么？  @ 引用对话文件，/ 调用技能与指令"
        :streaming="isStreaming"
        cleanup-on-unmount
        @submit="sendMessage"
        @stop="agentStore.cancelMessage()"
        @navigate="onPlusNavigate"
      />
    </div>

    <!-- Chat state -->
    <div v-else :class="['chat-area', { 'chat-area--doc-ratio': sideRatioMode }]">
      <div v-show="!panelFullscreen" class="chat-main">
        <!-- 会话标题栏 -->
        <header class="chat-header">
          <h1 class="chat-header-title">{{ agentStore.currentConversation?.title ?? '新对话' }}</h1>
          <div class="chat-header-actions">
            <!-- 对话内搜索条：浮层出现在"对话内搜索"图标左侧 -->
            <Transition name="searchbar">
              <div v-if="searchOpen" class="chat-search-bar">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  v-model="searchKeyword"
                  class="chat-search-input"
                  placeholder="搜索当前对话"
                />
                <span class="chat-search-count"
                  >{{ searchMatches.length ? searchIndex + 1 : 0 }}/{{ searchMatches.length }}</span
                >
                <button
                  class="chat-search-btn"
                  title="上一条"
                  :disabled="!searchMatches.length"
                  @click="gotoSearch(-1)"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  >
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
                <button
                  class="chat-search-btn"
                  title="下一条"
                  :disabled="!searchMatches.length"
                  @click="gotoSearch(1)"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <button class="chat-search-btn" title="关闭" @click="closeSearch">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </Transition>
            <button
              class="chat-header-btn"
              title="对话内搜索"
              :class="{ 'chat-header-btn--active': searchOpen }"
              @click="searchOpen = !searchOpen"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            <button
              class="chat-header-btn"
              title="分享"
              :class="{ 'chat-header-btn--active': shareMode }"
              @click="openSharePanel"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </button>
            <div class="chat-header-btn-wrap" data-history-menu-trigger>
              <button
                class="chat-header-btn"
                title="历史提问"
                @click="historyMenuOpen = !historyMenuOpen"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </button>
              <Transition name="dropdown">
                <div v-if="historyMenuOpen" class="history-menu">
                  <p class="history-menu-title">历史提问 ({{ historyQuestions.length }})</p>
                  <div class="history-menu-list">
                    <button
                      v-for="q in historyQuestions"
                      :key="q.id"
                      class="history-menu-item"
                      @click="jumpToQuestion(q.id)"
                    >
                      <span class="history-menu-text">{{ q.content }}</span>
                      <span v-if="q.createdAt" class="history-menu-time">{{
                        formatTime(q.createdAt)
                      }}</span>
                    </button>
                    <p v-if="historyQuestions.length === 0" class="history-menu-empty">暂无提问</p>
                  </div>
                </div>
              </Transition>
            </div>
          </div>
        </header>

        <MessageList
          ref="messageListRef"
          :messages="messages"
          :share-mode="shareMode"
          :is-share-selected="isShareSelected"
          :hit-set="hitSet"
          :current-hit-id="currentHitId"
          :suppress-auto-scroll="suppressAutoScroll"
          :model="model"
          @open-doc="openDocFromList"
          @toggle-share="toggleShareSelected"
          @regenerate="regenerateLast"
        />
        <!-- 分享面板：底部、输入栏上方，全选 + 5 个分享动作 + 关闭 -->
        <ShareDialog
          :visible="shareMode"
          :selected-count="shareSelected.length"
          :total="messages.length"
          :all-checked="shareAllChecked"
          :all-indeterminate="shareAllIndeterminate"
          :qr-visible="qrModalOpen"
          :qr-data-url="qrDataUrl"
          :link="shareLink"
          @toggle-all="toggleShareAll"
          @share-wechat="shareToWechat"
          @share-moments="shareToMoments"
          @copy-link="copyShareLink"
          @generate-qr="generateQr"
          @open-browser="openShareInBrowser"
          @close="closeSharePanel"
          @close-qr="closeQrModal"
        />
        <!-- Compact input -->
        <div class="chat-input-bar">
          <PromptInput
            ref="promptRef"
            v-model:text="taskInput"
            v-model:model="model"
            v-model:custom-model-id="selectedCustomId"
            compact
            placeholder="继续输入…"
            :streaming="isStreaming"
            cleanup-on-unmount
            @submit="sendMessage"
            @stop="agentStore.cancelMessage()"
            @navigate="onPlusNavigate"
          />
        </div>
      </div>
      <ChatSidePanel
        ref="sidePanelRef"
        v-model:fullscreen="panelFullscreen"
        :ratio-mode="sideRatioMode"
        @ratio-exit="sideRatioMode = false"
      />
    </div>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   New Task Page
   ═══════════════════════════════════════════════════════════════════════════ */
.new-task-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* Welcome area */
.welcome-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 32px 40px;
  overflow-y: auto;
}

.welcome-heading {
  font-size: 28px;
  font-weight: 700;
  color: var(--kw-color-text);
  margin: 0 0 20px;
  text-align: center;
}

.welcome-highlight {
  color: var(--kw-color-brand);
}

/* Category pills */
.category-pills {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.category-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 999px;
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}

.category-pill:hover {
  background: var(--kw-color-brand-soft);
}

.category-pill--active {
  background: #1a2332;
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 10px rgba(26, 35, 50, 0.25);
}

/* Chips row */
.chips-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 720px;
  margin-bottom: -10px;
}

.chips-scroll-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.chips-scroll-btn:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-text-muted);
}

.chips-scroll {
  flex: 1;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}

.chips-scroll::-webkit-scrollbar {
  display: none;
}

.quick-chip-wrap {
  position: relative;
  display: flex;
  flex-shrink: 0;
}

.quick-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 12px;
  background: var(--kw-color-input-bg);
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.quick-chip:hover {
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand);
}

/* 已选中该场景对应专家：高亮（没选中任何专家时都不高亮） */
.quick-chip--active {
  border-color: var(--kw-color-brand);
  color: var(--kw-color-brand);
}

.chip-icon {
  display: flex;
  align-items: center;
  color: var(--kw-color-brand);
  transition: opacity 0.15s ease;
}

/* 移除入口：hover/focus 时 × 占用图标的位置（只淡入淡出、不改变 chip 尺寸与文字位置） */
.quick-chip-del {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--kw-color-text-muted);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.15s ease,
    color 0.15s ease;
}

.quick-chip-wrap:hover .quick-chip-del,
.quick-chip-wrap:focus-within .quick-chip-del {
  opacity: 1;
  pointer-events: auto;
}

.quick-chip-del:hover {
  color: var(--kw-color-brand);
}

/* 图标让位给 ×：只淡出、不脱离布局 */
.quick-chip-wrap:hover .chip-icon,
.quick-chip-wrap:focus-within .chip-icon {
  opacity: 0;
}

.mascot {
  flex-shrink: 0;
  margin-left: 4px;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Chat State
   ═══════════════════════════════════════════════════════════════════════════ */
.chat-area {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

/* 文档自动展开后左右 5:5（用户拖拽/收起/全屏时退出） */
.chat-area--doc-ratio .chat-main {
  flex: 0 1 50%;
}

/* 左侧对话+输入列（全屏右侧栏时隐藏） */
.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* Chat input bar */
/* ═══════════════════════════════════════════════════════════════════════════
   Chat Header（会话标题栏）
   ═══════════════════════════════════════════════════════════════════════════ */
.chat-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  flex-shrink: 0;
}

.chat-header-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.chat-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.chat-header-btn-wrap {
  position: relative;
  display: flex;
}

.chat-header-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.chat-header-btn:hover,
.chat-header-btn--active {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
}

/* 历史提问下拉 */
.history-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 320px;
  max-height: 360px;
  background: var(--kw-color-surface);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  border: 1px solid var(--kw-color-border-brand);
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.history-menu-title {
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kw-color-text-muted);
  border-bottom: 1px solid var(--kw-color-border-soft);
  flex-shrink: 0;
}

.history-menu-list {
  overflow-y: auto;
  padding: 4px;
}

.history-menu-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease;
}

.history-menu-item:hover {
  background: var(--kw-color-brand-hover);
}

.history-menu-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kw-color-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.history-menu-time {
  font-size: 11px;
  color: var(--kw-color-text-faint);
  flex-shrink: 0;
  padding-top: 2px;
}

.history-menu-empty {
  margin: 0;
  padding: 16px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
  text-align: center;
}

/* 对话内搜索条：header 内浮层，出现在"对话内搜索"图标左侧
   （right 相对 header padding box：3 个按钮 × 30px + 2 个间距 × 2px + 右侧 padding 24px + 6px 留白） */
.chat-search-bar {
  position: absolute;
  top: 50%;
  right: calc(30px * 3 + 2px * 2 + 24px + 6px);
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  width: 320px;
  padding: 6px 10px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 10px;
  background: var(--kw-color-surface);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.1);
  z-index: 30;
  color: var(--kw-color-text-faint);
}

.chat-search-input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  color: var(--kw-color-text);
  min-width: 0;
}

.chat-search-input::placeholder {
  color: var(--kw-color-text-faint);
}

.chat-search-count {
  font-size: 11px;
  color: var(--kw-color-text-subtle);
  flex-shrink: 0;
}

.chat-search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.chat-search-btn:hover:not(:disabled) {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
}

.chat-search-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 搜索条浮层过渡：仅淡入淡出（浮层本身有 translateY(-50%) 定位，不做位移过渡） */
.searchbar-enter-active,
.searchbar-leave-active {
  transition: opacity 0.15s ease;
}

.searchbar-enter-from,
.searchbar-leave-to {
  opacity: 0;
}

/* Toast */
.chat-input-bar {
  /* 与对话区同宽居中（max-width 与 margin auto 必须同写） */
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 0 0 24px;
}

/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Responsive
   ═══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 768px) {
  .welcome-area {
    padding: 40px 20px 32px;
  }

  .welcome-heading {
    font-size: 24px;
  }

  .mascot {
    display: none;
  }

  .chat-messages {
    padding: 40px 20px 12px;
  }

  .chat-input-bar {
    padding: 0 0 16px;
  }
}

@media (max-width: 440px) {
  .category-pills {
    flex-wrap: wrap;
    justify-content: center;
  }

  .chips-row {
    gap: 4px;
  }

  .input-toolbar {
    padding: 0 8px 10px;
  }
}

</style>
