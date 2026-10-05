<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useAgentStore } from '@store/agent'
import { useSettingsStore } from '@store/settings'
import BrandMark from '@components/brand/BrandMark.vue'
import MessageContent from '@components/MessageContent.vue'
import ThinkingBlock from '@components/ThinkingBlock.vue'
import MessageActions from '@components/MessageActions.vue'
import { useVideoArtifacts } from '@renderer/composables/useVideoArtifacts'

/**
 * 消息列表（R6：自 NewTaskPage 外提）——滚动容器 + 消息循环 + 滚动定位按钮。
 *
 * 随迁的内部机制：滚动状态机（atTop/atBottom/追滚/回顶回底）、历史回显滚底、
 * 委派专家计时、成片播放（useVideoArtifacts 在组件内实例化，页面不再持有该状态）。
 * 页面仍持有并注入：搜索命中态（hitSet/currentHitId）、分享选中态、抑制追滚标志；
 * 通过 defineExpose 暴露 `stickToBottom()`（重新生成时强制跟随）与 `refreshScrollState()`。
 */

interface ListMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  createdAt?: number
  durationMs?: number
  model?: string
  files?: Array<{ name: string; relPath: string; ext: string; workspaceId?: string | null }>
}

const props = defineProps<{
  /** 消息列表（页面映射后的展示形态） */
  messages: ListMessage[]
  /** 分享选择模式（每条消息左侧出现复选框） */
  shareMode: boolean
  /** 分享选中判定 */
  isShareSelected: (id: string) => boolean
  /** 对话内搜索命中集合 */
  hitSet: Set<string>
  /** 搜索当前定位命中 id */
  currentHitId: string | null
  /** 搜索/历史定位期间抑制自动跟随 */
  suppressAutoScroll: boolean
  /** 未记录模型时的默认展示名（透传给操作栏） */
  model: string
}>()

const emit = defineEmits<{
  /** 打开文档产物（relPath 必传；name 为消息卡片上的展示名，缺省由页面按 basename 推导） */
  openDoc: [relPath: string, name?: string]
  /** 分享选择：切换某条消息的选中态 */
  toggleShare: [id: string]
  /** 重新生成最后一条回复 */
  regenerate: []
}>()

const agentStore = useAgentStore()
const settingsStore = useSettingsStore()

const currentMessages = computed(() => agentStore.currentMessages)
const isStreaming = computed(() => agentStore.isStreaming)
const isThinking = computed(() => agentStore.isThinking)
const currentWorkspaceId = computed(
  () => agentStore.currentConversation?.workspace?.id ?? undefined
)

// ── 消息内成片播放（扫描消息 files → Blob URL；随组件实例化） ──
const { isVideoArtifact, videoArtifactSrc, videoArtifactFailed } = useVideoArtifacts({
  workspaceId: currentWorkspaceId,
  messages: currentMessages
})

const thinking = computed(() => isStreaming.value || isThinking.value)

const findLastAssistant = (): ListMessage | null => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (props.messages[i].role === 'assistant') {
      return props.messages[i]
    }
  }
  return null
}

const isLastAssistant = (msgId: string): boolean => findLastAssistant()?.id === msgId

/** 该思考块是否正在输出（此消息为最后一条 AI 消息且思考流未结束） */
function isThinkingNow(msgId: string): boolean {
  return isStreaming.value && isThinking.value && isLastAssistant(msgId)
}

// ── 委派专家进行中：动态状态提示（主智能体拆分任务交给专家时给出明确反馈）──
const activeDelegation = computed(() => {
  const list = agentStore.activeDelegations
  return list.length > 0 ? list[list.length - 1] : null
})

/** 当前委派已等待秒数：长任务期间持续刷新，表明仍在进行 */
const delegationWaitSec = ref(0)
let delegationTimer: ReturnType<typeof setInterval> | null = null

watch(activeDelegation, (val) => {
  if (delegationTimer) {
    clearInterval(delegationTimer)
    delegationTimer = null
  }
  delegationWaitSec.value = 0
  if (!val) return
  delegationTimer = setInterval(() => {
    delegationWaitSec.value += 1
  }, 1000)
})

onUnmounted(() => {
  if (delegationTimer) clearInterval(delegationTimer)
})

// ── 消息区滚动状态（追滚/回顶回底按钮的数据源）──
const messagesScrollRef = ref<HTMLElement | null>(null)
const SCROLL_NEAR_EDGE = 40
const atTop = ref(true)
const atBottom = ref(true)

/** 由容器 scroll 事件驱动：按 40px 阈值刷新「接近顶部/底部」状态 */
const updateScrollState = (): void => {
  const el = messagesScrollRef.value
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  atTop.value = el.scrollTop <= SCROLL_NEAR_EDGE
  atBottom.value = el.scrollTop >= max - SCROLL_NEAR_EDGE
}

/** 容器挂载时刷新一次状态（初次渲染无 scroll 事件，避免状态残留默认值） */
watch(messagesScrollRef, (el) => {
  if (!el) return
  updateScrollState()
  // 回显路径：页面挂载时消息已加载（从其它标签切到新建任务打开会话），直接滚底
  if (currentMessages.value.length > 0) scrollMessagesToBottom()
})

/** 回顶/回底跳转（按钮点击，smooth 滚动） */
const scrollToTop = (): void => {
  messagesScrollRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

const scrollToBottom = (): void => {
  const el = messagesScrollRef.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

// 最后一条 assistant 消息的正文+思考长度（流式逐块增长时驱动实时追滚）
const lastAssistantContentLen = computed(() => {
  for (let i = currentMessages.value.length - 1; i >= 0; i--) {
    const m = currentMessages.value[i]
    if (m.role === 'assistant') {
      return (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
    }
  }
  return 0
})

/** 用户位于底部时，把消息区滚到底部（瞬时赋值，流式高频增长不用 smooth） */
const scrollMessagesToBottom = (): void => {
  const el = messagesScrollRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  updateScrollState()
}

// 消息增删 / 流式开始结束：位于底部时滚底（搜索/历史提问定位期间抑制）
watch(
  () => [currentMessages.value.length, isStreaming.value],
  () => {
    if (props.suppressAutoScroll) return
    if (!atBottom.value) return
    nextTick(scrollMessagesToBottom)
  }
)

// 流式内容逐块增长：位于底部时实时追滚（用户向上翻阅后 atBottom=false 即暂停跟随）
watch(lastAssistantContentLen, () => {
  if (props.suppressAutoScroll) return
  if (!atBottom.value) return
  nextTick(scrollMessagesToBottom)
})

// ── 历史会话回显：切换会话后等消息加载完成滚到底部（修复残留上次滚动位置问题）──
const echoPendingScroll = ref(false)

watch(
  () => agentStore.currentConversationId,
  () => {
    echoPendingScroll.value = true
  }
)

watch(
  () => currentMessages.value.length,
  (len) => {
    if (echoPendingScroll.value && len > 0) {
      echoPendingScroll.value = false
      nextTick(scrollMessagesToBottom)
    }
  }
)

defineExpose({
  /** 强制恢复底部跟随（重新生成等用户主动动作） */
  stickToBottom: (): void => {
    atBottom.value = true
  },
  /** 外部布局变化后刷新滚动状态（如右侧栏全屏切换） */
  refreshScrollState: (): void => {
    nextTick(updateScrollState)
  }
})
</script>

<template>
  <div ref="messagesScrollRef" class="chat-messages" @scroll="updateScrollState">
    <div
      v-for="msg in props.messages"
      :key="msg.id"
      :data-msg-id="msg.id"
      :class="[
        'chat-bubble-row',
        msg.role === 'user' ? 'chat-bubble-row--user' : 'chat-bubble-row--assistant',
        {
          'chat-msg--hit': props.hitSet.has(msg.id),
          'chat-msg--current': props.currentHitId === msg.id,
          'chat-msg-row--selected': props.isShareSelected(msg.id)
        }
      ]"
    >
      <!-- 分享选择模式：消息最左侧复选框 -->
      <label
        v-if="props.shareMode"
        class="chat-msg-check"
        :class="{ 'chat-msg-check--selected': props.isShareSelected(msg.id) }"
        :title="props.isShareSelected(msg.id) ? '取消选中' : '选中该消息'"
        @click.prevent="emit('toggleShare', msg.id)"
      >
        <input type="checkbox" :checked="props.isShareSelected(msg.id)" />
        <span class="chat-msg-check-box">
          <svg
            v-if="props.isShareSelected(msg.id)"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      </label>
      <!-- AI 回复：头像+名字在顶部，正文无背景色，底部操作栏 -->
      <template v-if="msg.role === 'assistant'">
        <div class="chat-bubble-head">
          <div class="chat-avatar chat-avatar--ai chat-avatar--sm">
            <BrandMark
              :size="16"
              variant="mark"
            />
          </div>
          <span class="chat-bubble-head-name">{{ settingsStore.systemName }}</span>
        </div>
        <div class="chat-bubble-wrapper">
          <!-- 深度思考块：高度受限+内部滚动+输出提示；「展开浏览」放宽高度上限 -->
          <ThinkingBlock
            v-if="msg.reasoning"
            :reasoning="msg.reasoning"
            :active="isThinkingNow(msg.id)"
            :workspace-id="currentWorkspaceId"
            @open-file="(relPath) => emit('openDoc', relPath)"
          />
          <!-- 消息内容：有内容时渲染，空内容+流式输出时显示加载动画 -->
          <div v-if="msg.content" class="chat-bubble">
            <MessageContent
              :content="msg.content"
              content-type="markdown"
              :workspace-id="currentWorkspaceId"
              @open-file="(relPath) => emit('openDoc', relPath)"
            />
          </div>
          <!-- 等待首块输出：无正文且无思考时显示加载动画（思考块/委派提示已给状态时不重复） -->
          <div
            v-if="
              !msg.content &&
              !msg.reasoning &&
              !activeDelegation &&
              isLastAssistant(msg.id) &&
              thinking
            "
            class="chat-bubble thinking-bubble"
          >
            <span class="dot-pulse" style="animation-delay: 0s"></span>
            <span class="dot-pulse" style="animation-delay: 0.15s"></span>
            <span class="dot-pulse" style="animation-delay: 0.3s"></span>
          </div>
          <!-- 生成文档链接条：live 与历史回显共用同一模板 -->
          <div v-if="msg.files && msg.files.length" class="msg-artifacts">
            <template v-for="file in msg.files" :key="file.relPath">
              <!-- 视频产物：直接给出播放入口（不依赖模型是否把 <video> 写进回复） -->
              <video
                v-if="isVideoArtifact(file) && videoArtifactSrc[file.relPath]"
                class="msg-video"
                :src="videoArtifactSrc[file.relPath]"
                :title="file.relPath"
                controls
                preload="metadata"
              ></video>
              <button
                v-else
                class="msg-artifact-link"
                :class="{ 'msg-artifact-link--failed': videoArtifactFailed[file.relPath] }"
                :title="file.relPath"
                @click="emit('openDoc', file.relPath, file.name)"
              >
                <span class="msg-artifact-ico">📄</span>
                <span class="msg-artifact-name">{{ file.name }}</span>
              </button>
            </template>
          </div>
          <!-- 委派专家进行中：主智能体拆分任务交给专家时的动态状态（长任务期间界面不空转） -->
          <div
            v-if="activeDelegation && isLastAssistant(msg.id) && thinking"
            class="chat-bubble delegate-bubble"
            :title="activeDelegation.description"
          >
            <span class="delegate-spinner"></span>
            <span class="delegate-text">正在委派「{{ activeDelegation.name }}」处理…</span>
            <span v-if="delegationWaitSec > 0" class="delegate-elapsed">{{ delegationWaitSec }}s</span>
          </div>
        </div>
        <!-- 操作栏：按钮组 + 元信息 -->
        <MessageActions
          :msg="msg"
          :streaming="isStreaming"
          :is-last="isLastAssistant(msg.id)"
          :default-model="props.model"
          @regenerate="emit('regenerate')"
        />
      </template>
      <!-- 用户消息：无头像，浅灰背景 -->
      <template v-else>
        <div class="chat-bubble-wrapper chat-bubble-wrapper--user">
          <div class="chat-bubble chat-bubble--user">
            <!-- 用户输入按行断行（GFM 软换行）：多行提问保持输入的换行结构 -->
            <MessageContent
              :content="msg.content"
              content-type="markdown"
              :workspace-id="currentWorkspaceId"
              :breaks="true"
              @open-file="(relPath) => emit('openDoc', relPath)"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
  <!-- 消息区滚动定位按钮：接近顶部→回底，接近底部→回顶；中间位置不显示 -->
  <button
    v-if="atTop && !atBottom"
    class="chat-scroll-jump"
    title="回到底部"
    @click="scrollToBottom"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>
  <button
    v-else-if="atBottom && !atTop"
    class="chat-scroll-jump"
    title="回到顶部"
    @click="scrollToTop"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  </button>
</template>

<style scoped>
.msg-artifact-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 5px 10px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 8px;
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-brand);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.msg-artifact-link:hover {
  background: var(--kw-color-brand-hover);
}

.msg-artifact-ico {
  flex-shrink: 0;
}

.msg-artifact-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  /* 全宽滚动容器：滚动条贴右缘（右栏分割线），内容保持 760px 居中列（窄窗钳制 32px 留白） */
  padding: 48px max(32px, calc((100% - 760px) / 2)) 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 细窄滚动条：内容不溢出时不显示，溢出时出现在消息区最右缘（分割线旁） */
  scrollbar-width: thin;
  scrollbar-color: rgba(8, 145, 178, 0.28) transparent;
  width: 100%;
}

.chat-messages::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: var(--kw-color-border-brand);
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: var(--kw-color-border-brand);
}

.chat-scroll-jump:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  box-shadow: 0 2px 12px rgba(8, 145, 178, 0.25);
}

.chat-bubble-row {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  border-radius: 10px;
  transition: background-color 0.15s ease;
}

.chat-msg--current {
  background: #fef3c7;
}

.chat-msg-check input {
  display: none;
}

.chat-msg-check-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1.5px solid var(--kw-color-border-strong);
  background: var(--kw-color-surface);
  box-sizing: border-box;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.chat-msg-check:hover .chat-msg-check-box {
  border-color: var(--kw-color-brand);
}

.chat-msg-check--selected .chat-msg-check-box {
  background: var(--kw-color-brand);
  border-color: var(--kw-color-brand);
}

.chat-bubble-row--user {
  justify-content: flex-end;
}

.chat-avatar--sm {
  width: 20px;
  height: 20px;
  margin-top: 0;
}

.chat-avatar--ai {
  background: var(--kw-gradient-brand);
}

.chat-bubble-head-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.chat-bubble-wrapper--user {
  align-items: flex-end;
}

.dot-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kw-color-brand);
  animation: dotBounce 0.6s ease-in-out infinite;
}

@keyframes dotBounce {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-4px);
  }
}

.delegate-spinner {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--kw-color-brand);
  border-top-color: transparent;
  animation: delegateSpin 0.8s linear infinite;
}

.delegate-text {
  color: var(--kw-color-brand);
  font-weight: 500;
}

.delegate-elapsed {
  color: var(--kw-color-text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

@keyframes delegateSpin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 768px) {

  .chat-messages {
    padding: 40px 20px 12px;
  }
}


/* AI 回复下的生成文档文件链接条（live 与历史回显共用） */
.msg-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

/* 消息内成片播放器（视频产物直接可播） */
.msg-video {
  display: block;
  width: 100%;
  max-width: 320px;
  max-height: 420px;
  border-radius: var(--radius-lg, 8px);
  background: #000;
}

/* 成片读取失败时给出可见提示，而不是静默消失 */
.msg-artifact-link--failed {
  border-color: var(--kw-color-danger, #d9534f);
  opacity: 0.75;
}

/* 消息区浮动跳转按钮（与 760px 消息列右缘对齐；悬于输入栏上方） */
.chat-scroll-jump {
  position: absolute;
  right: max(8px, calc(50% - 380px));
  bottom: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 50%;
  background: var(--kw-color-surface);
  color: var(--kw-color-brand-strong);
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.12);
  z-index: 10;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
}

/* 搜索高亮：命中行淡黄、当前定位行深黄 */
.chat-msg--hit {
  background: #fffbe6;
}

/* 分享选择模式：选中消息行高亮 */
.chat-msg-row--selected {
  background: var(--kw-color-brand-hover);
}

/* 分享选择模式：行内出现复选框时左侧让位（:has 兼容 Electron 39 / Chromium 高版本） */
.chat-bubble-row:has(.chat-msg-check) {
  padding-left: 26px;
}

/* 消息行复选框（分享选择模式下显示，位于每条消息最左侧） */
.chat-msg-check {
  position: absolute;
  left: 0;
  top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  cursor: pointer;
  z-index: 2;
}

/* AI 回复行纵向化：头部（头像+名字）在上，正文中，操作栏在下 */
.chat-bubble-row--assistant {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
}

/* AI 头像：顶部头部行内的小尺寸 */
.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

/* AI 消息头部行：头像 + 系统名称 */
.chat-bubble-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

/* 正文：无背景色（接近左侧白底） */
.chat-bubble {
  padding: 0;
  border-radius: 18px;
  font-size: 14px;
  line-height: 1.6;
  background: transparent;
  color: var(--kw-color-text);
}

/* 用户消息：浅灰背景 */
.chat-bubble--user {
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text);
  border-radius: 18px;
  border-bottom-right-radius: 4px;
  padding: 12px 16px;
}

/* Chat bubble wrapper (for reasoning + content layout) */
.chat-bubble-wrapper {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* 思考消息与正式消息的间隔 */
  gap: 16px;
}

/* Thinking bubble (loading dots) */
.thinking-bubble {
  display: flex;
  align-items: center;
  gap: 4px;
  /* 基类 padding 已归零，加载气泡自持外观 */
  padding: 12px 16px;
  background: var(--kw-color-input-bg);
  border-radius: 18px 18px 18px 4px;
}

/* 委派专家进行中：旋转指示 + 文案 + 已等待秒数（气泡贴合内容宽度） */
.delegate-bubble {
  display: flex;
  align-items: center;
  align-self: flex-start;
  gap: 8px;
  padding: 10px 14px;
  background: var(--kw-color-input-bg);
  border-radius: 14px 14px 14px 4px;
  font-size: 13px;
}
</style>
