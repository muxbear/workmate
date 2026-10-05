<script setup lang="ts">
import { ref } from 'vue'
import { copyText } from '@renderer/composables/clipboard'
import { showToast } from '@renderer/composables/useToast'

/**
 * AI 消息操作栏（R6：自 NewTaskPage 外提）。
 *
 * 原实现用按消息 id 键控的全局表（feedbackMap / speakingMsgId）承载点赞与朗读状态，
 * 组件化后收敛为**实例内状态**；「重新生成」仅最后一条消息且非流式中可用，经 emit 交给页面。
 */
const props = defineProps<{
  /** 消息（正文 / 耗时 / 模型 / 时间元信息） */
  msg: {
    id: string
    content: string
    durationMs?: number
    model?: string
    createdAt?: number
  }
  /** 流式输出中（重新生成按钮禁用） */
  streaming: boolean
  /** 本消息为最后一条 AI 消息（重新生成仅此条可用） */
  isLast: boolean
  /** 未记录模型时的默认展示名 */
  defaultModel: string
}>()

const emit = defineEmits<{ regenerate: [] }>()

/** 点赞/点踩（本地状态；再点一次取消） */
const feedback = ref<'up' | 'down' | null>(null)
const toggleFeedback = (kind: 'up' | 'down'): void => {
  feedback.value = feedback.value === kind ? null : kind
}

/** 朗读 AI 回复（Web Speech API；无引擎降级提示） */
const speaking = ref(false)
const toggleSpeak = (): void => {
  if (!('speechSynthesis' in window)) {
    showToast('当前环境不支持语音朗读')
    return
  }
  if (speaking.value) {
    window.speechSynthesis.cancel()
    speaking.value = false
    return
  }
  window.speechSynthesis.cancel()
  const utter = new SpeechSynthesisUtterance(props.msg.content)
  utter.lang = 'zh-CN'
  speaking.value = true
  utter.onend = () => {
    speaking.value = false
  }
  utter.onerror = () => {
    speaking.value = false
  }
  window.speechSynthesis.speak(utter)
  // 降级：speak 后 1.5s 未进入朗读状态视为不支持
  setTimeout(() => {
    if (speaking.value && !window.speechSynthesis.speaking) {
      speaking.value = false
      showToast('当前环境不支持语音朗读')
    }
  }, 1500)
}

/** 生成耗时文案 */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return '共 <1s'
  if (ms < 60_000) return `共 ${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `共 ${m}m ${s}s`
}

const formatTime = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div v-if="props.msg.content" class="chat-msg-actions">
    <div class="chat-msg-action-group">
      <button class="chat-msg-action-btn" title="复制" @click="copyText(props.msg.content)">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
      <button
        class="chat-msg-action-btn"
        :class="{ 'chat-msg-action-btn--active': feedback === 'up' }"
        title="点赞"
        @click="toggleFeedback('up')"
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
          <path
            d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"
          />
        </svg>
      </button>
      <button
        class="chat-msg-action-btn"
        :class="{ 'chat-msg-action-btn--active': feedback === 'down' }"
        title="点踩"
        @click="toggleFeedback('down')"
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
          <path
            d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"
          />
        </svg>
      </button>
      <button
        class="chat-msg-action-btn"
        :class="{ 'chat-msg-action-btn--active': speaking }"
        title="朗读"
        @click="toggleSpeak"
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
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      </button>
      <button
        class="chat-msg-action-btn"
        title="重新生成"
        :disabled="props.streaming || !props.isLast"
        @click="emit('regenerate')"
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
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>
      <button class="chat-msg-action-btn" title="分享" @click="copyText(props.msg.content)">
        <svg
          width="13"
          height="13"
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
      <button class="chat-msg-action-btn" title="更多">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </div>
    <div class="chat-msg-meta">
      <span v-if="props.msg.durationMs" class="chat-msg-meta-item chat-msg-meta-item--strong">
        {{ formatDuration(props.msg.durationMs) }}
      </span>
      <span class="chat-msg-meta-item">{{ props.msg.model ?? props.defaultModel }}</span>
      <span v-if="props.msg.createdAt" class="chat-msg-meta-item">{{
        formatTime(props.msg.createdAt)
      }}</span>
    </div>
  </div>
</template>

<style scoped>
.chat-msg-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}

.chat-msg-action-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.chat-msg-action-btn {
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
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.chat-msg-action-btn:hover:not(:disabled) {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.chat-msg-action-btn--active {
  color: var(--kw-color-brand);
}

.chat-msg-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-msg-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  font-size: 11px;
  color: var(--kw-color-text-faint);
  flex-shrink: 0;
}

.chat-msg-meta-item--strong {
  color: var(--kw-color-text-secondary);
}
</style>
