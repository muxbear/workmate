<script setup>
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore } from '@/stores/chat'
import MessageItem from './MessageItem.vue'

const chatStore = useChatStore()
const scrollContainer = ref(null)

// 用户手动向上滚动后不再强制跟随，避免打断阅读
const stickToBottom = ref(true)
let settleTimer = null

const lastContent = computed(() => {
  const msgs = chatStore.messages
  if (msgs.length === 0) return ''
  return msgs[msgs.length - 1].content
})

const streamingBlocksLen = computed(() => {
  const last = chatStore.messages[chatStore.messages.length - 1]
  if (last?.blocks) return last.blocks.length
  return 0
})

function scrollToBottom() {
  nextTick(() => {
    const el = scrollContainer.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

/** 历史回显与流式输出时内容高度会分多批变化（代码块、图片），短时间内持续对齐底部 */
function scrollToBottomSettled() {
  if (settleTimer !== null) {
    window.clearTimeout(settleTimer)
    settleTimer = null
  }
  stickToBottom.value = true

  const startedAt = Date.now()
  const tick = () => {
    scrollToBottom()
    if (Date.now() - startedAt < 1000) {
      settleTimer = window.setTimeout(tick, 80)
    } else {
      settleTimer = null
    }
  }
  tick()
}

/** 用户滚动时记录是否仍停留在底部 */
function handleScroll() {
  const el = scrollContainer.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

/** 增量内容到达时仅在用户处于底部附近时跟随 */
function followIfSticky() {
  if (stickToBottom.value) scrollToBottom()
}

watch(() => chatStore.messages.length, followIfSticky)
watch(lastContent, followIfSticky)
watch(streamingBlocksLen, followIfSticky)
// 切换会话（含历史回显）时直接回到底部，展示最新回复
watch(() => chatStore.threadId, scrollToBottomSettled)

onMounted(scrollToBottomSettled)
onBeforeUnmount(() => {
  if (settleTimer !== null) window.clearTimeout(settleTimer)
  settleTimer = null
})
</script>

<template>
  <div class="message-list" ref="scrollContainer" @scroll="handleScroll">
    <div
      v-for="msg in chatStore.messages"
      :key="msg.id"
      :data-msg-id="msg.id"
      class="message-row"
      :class="{
        'message-row--hit': chatStore.isSearchHit(msg.id),
        'message-row--share': chatStore.shareMode,
      }"
    >
      <label
        v-if="chatStore.shareMode"
        class="share-check"
        title="选择该消息"
        @click.prevent="chatStore.toggleShareSelect(msg.id)"
      >
        <input type="checkbox" :checked="chatStore.shareSelected.includes(msg.id)" />
      </label>
      <MessageItem :message="msg" />
    </div>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 72px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--surface-primary);
}

.message-row {
  display: flex;
  width: 100%;
}

.message-row--hit {
  outline: 1px solid var(--accent-primary);
  outline-offset: 4px;
  border-radius: var(--radius-lg);
}

.message-row--share {
  align-items: center;
  gap: 8px;
}

.share-check {
  display: flex;
  align-items: center;
  cursor: pointer;
}
</style>
