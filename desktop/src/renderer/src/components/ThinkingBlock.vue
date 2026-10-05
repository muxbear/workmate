<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import MessageContent from '@components/MessageContent.vue'

/**
 * 思考块（R6：自 NewTaskPage 外提）。
 *
 * 原实现用 7 张按消息 id 键控的全局表（collapsed/expanded/overflow/follow/touched/bodies +
 * 注册回调）承载每消息状态，regenerate 截断后还要靠 id 而非 index 自保；组件化后全部收敛为
 * **实例内状态**——折叠/展开、内滚动跟随、溢出测量各自独立，互不干扰。
 *
 * 直播行为由 `active`（本消息为最后一条 AI 消息且思考流未结束）驱动：
 * - 内容增长 → 内部滚动跟随 + 溢出测量（用户上翻后暂停跟随）；
 * - 思考结束（active 真→假）→ 自动收起为一行（用户手动操作过则保持现状）；
 * - 历史消息挂载即收起（`collapsed` 初值取 `!active`），替代原「消息 id 列表变化时批量收起」的回声 watch。
 */
const props = defineProps<{
  /** 思考内容（markdown） */
  reasoning: string
  /** 正在思考：本消息为最后一条 AI 消息且思考流未结束 */
  active: boolean
  /** 工作空间（思考内产物链接解析） */
  workspaceId?: string
}>()

const emit = defineEmits<{ 'open-file': [relPath: string] }>()

/** 折叠为一行（历史消息默认收起；直播中默认展开） */
const collapsed = ref(!props.active)
/** 展开浏览（高度上限放宽到阅读高度；默认在紧凑高度内滚动） */
const expanded = ref(false)
/** 内容是否超出紧凑高度（决定「展开浏览」入口是否出现）；一旦为真保持为真 */
const overflow = ref(false)
/** 内部滚动是否跟随输出（用户向上翻阅后暂停跟随） */
let follow = true
/** 用户手动操作过：思考结束后不自动收起，尊重用户意图 */
let touched = false

/** 思考块正文滚动容器 */
const bodyEl = ref<HTMLElement | null>(null)
/** 贴近底部判定阈值（px）：留容差，避免逐像素误差把跟随判停 */
const THINKING_FOLLOW_GAP = 24

/** 内部滚到底（流式逐块增长时跟随输出；force 用于用户主动展开时定位到最新） */
function scrollToBottom(force = false): void {
  const el = bodyEl.value
  if (!el) return
  if (!force && !follow) return
  el.scrollTop = el.scrollHeight
  follow = true
}

/** 内部滚动事件：刷新「是否仍贴近底部」，决定后续输出是否继续跟随 */
function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  follow = el.scrollHeight - el.scrollTop - el.clientHeight <= THINKING_FOLLOW_GAP
}

/** 内容超出紧凑高度 → 出现「展开浏览」；折叠隐藏（高度为 0）时不测量，保留既有判断 */
function updateOverflow(): void {
  if (overflow.value) return
  const el = bodyEl.value
  if (!el || el.clientHeight === 0) return
  overflow.value = el.scrollHeight > el.clientHeight + 1
}

// 直播内容增长：跟随滚动 + 溢出测量（历史消息的 reasoning 不再变化，不会触发）
watch(
  () => props.reasoning,
  () => {
    nextTick(() => {
      scrollToBottom()
      updateOverflow()
    })
  }
)

// 思考流结束：自动收起为一行（用户手动操作过则保持现状，不打扰阅读）
watch(
  () => props.active,
  (now, prev) => {
    if (!prev || now) return
    if (touched) return
    collapsed.value = true
  }
)

// 挂载即展开的块（直播中的消息）：首帧测量一次溢出（历史块默认收起，无需测量）
onMounted(() => {
  if (!collapsed.value) nextTick(updateOverflow)
})

/** 折叠/展开切换（手动操作后不再自动收起）；展开时定位到最新输出 */
function toggle(): void {
  touched = true
  collapsed.value = !collapsed.value
  if (!collapsed.value) {
    nextTick(() => {
      scrollToBottom(true)
      updateOverflow()
    })
  }
}

/** 展开浏览 / 收起：紧凑高度 ↔ 阅读高度 */
function toggleExpand(): void {
  touched = true
  expanded.value = !expanded.value
  nextTick(updateOverflow)
}
</script>

<template>
  <div class="thinking-block">
    <button class="thinking-header" @click="toggle">
      <span class="thinking-header-text">
        深度思考
        <span v-if="props.active" class="thinking-live">
          <span class="thinking-live-dot"></span>
          <span class="thinking-live-text">正在思考…</span>
        </span>
      </span>
      <span
        v-if="overflow && !collapsed"
        class="thinking-expand"
        :title="expanded ? '收起为紧凑高度' : '展开浏览完整思考'"
        @click.stop="toggleExpand"
      >
        {{ expanded ? '收起' : '展开浏览' }}
      </span>
      <svg
        :class="['thinking-chevron', { 'thinking-chevron--collapsed': collapsed }]"
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
    <Transition name="thinking-collapse">
      <div
        v-show="!collapsed"
        ref="bodyEl"
        :class="['thinking-body', { 'thinking-body--expanded': expanded }]"
        @scroll="onScroll"
      >
        <MessageContent
          :content="props.reasoning"
          content-type="markdown"
          :workspace-id="props.workspaceId"
          @open-file="(relPath: string) => emit('open-file', relPath)"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.thinking-block {
  border-radius: 14px 14px 4px 4px;
  background: var(--kw-color-brand-hover);
  border: 1px solid var(--kw-color-border-brand);
  border-left: 3px solid #0891b2;
  overflow: hidden;
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--kw-color-brand);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.thinking-header:hover {
  background: var(--kw-color-brand-hover);
}

.thinking-header-text {
  flex: 1;
  text-align: left;
  display: flex;
  align-items: center;
}

/* 思考输出中的提示：呼吸圆点 + 文案（仅流式期间出现） */
.thinking-live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  font-weight: 500;
  color: var(--kw-color-brand);
}

.thinking-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: thinkingPulse 1s ease-in-out infinite;
}

.thinking-live-text {
  animation: thinkingBreathe 1.4s ease-in-out infinite;
}

@keyframes thinkingPulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }

  50% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes thinkingBreathe {
  0%,
  100% {
    opacity: 0.55;
  }

  50% {
    opacity: 1;
  }
}

/* 「展开浏览 / 收起」：内容超出紧凑高度时出现，切换阅读高度 */
.thinking-expand {
  flex-shrink: 0;
  margin-right: 8px;
  padding: 1px 8px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 999px;
  background: var(--kw-color-surface);
  color: var(--kw-color-brand);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.thinking-expand:hover {
  background: var(--kw-color-brand-hover);
  border-color: var(--kw-color-brand);
}

.thinking-chevron {
  flex-shrink: 0;
  color: var(--kw-color-brand);
  transition: transform 0.2s ease;
}

.thinking-chevron--collapsed {
  transform: rotate(-90deg);
}

.thinking-body {
  padding: 6px 14px 10px;
  font-size: 13px;
  line-height: 1.6;
  /* 思考消息：淡灰文字，hover 变深灰 */
  color: var(--kw-color-text-faint);
  border-top: 1px solid var(--kw-color-border-brand);
  transition: color 0.15s ease;
  /* 高度上限：思考输出不随内容无限拉长，超出后在块内滚动 */
  max-height: 200px;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 逐块重渲染（v-html 整体替换）会触发浏览器滚动锚定自行调 scrollTop：
     用户上翻阅读时会被莫名拽动，这里禁用锚定，交给上面的跟随逻辑 */
  overflow-anchor: none;
  /* 细滚动条：内容未超出时不出现，出现时也不喧宾夺主 */
  scrollbar-width: thin;
  scrollbar-color: var(--kw-color-border-strong) transparent;
}

/* 展开浏览：放宽到阅读高度（仍有限，避免长思考把消息区顶飞） */
.thinking-body--expanded {
  max-height: min(70vh, 720px);
}

.thinking-body::-webkit-scrollbar {
  width: 8px;
}

.thinking-body::-webkit-scrollbar-thumb {
  background: var(--kw-color-border-strong);
  border-radius: 4px;
}

.thinking-body::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-block:hover .thinking-body {
  color: var(--kw-color-text-secondary);
}

/* 思考块内嵌元素颜色统一为淡灰（保留 code/pre 原配色保证可读性） */
.thinking-body :deep(.message-content--rich p),
.thinking-body :deep(.message-content--rich li),
.thinking-body :deep(.message-content--rich strong),
.thinking-body :deep(.message-content--rich td),
.thinking-body :deep(.message-content--rich h1),
.thinking-body :deep(.message-content--rich h2),
.thinking-body :deep(.message-content--rich h3),
.thinking-body :deep(.message-content--rich h4) {
  color: inherit;
}

/* Thinking collapse transition */
.thinking-collapse-enter-active,
.thinking-collapse-leave-active {
  transition:
    opacity 0.2s ease,
    max-height 0.25s ease;
  overflow: hidden;
}

.thinking-collapse-enter-from,
.thinking-collapse-leave-to {
  opacity: 0;
  max-height: 0;
}
</style>
