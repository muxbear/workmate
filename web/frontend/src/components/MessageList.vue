<script setup>
import { ref, watch, nextTick, computed } from 'vue'
import { useChatStore } from '@/stores/chat'
import MessageItem from './MessageItem.vue'

const chatStore = useChatStore()
const scrollContainer = ref(null)

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

watch(() => chatStore.messages.length, scrollToBottom)
watch(lastContent, scrollToBottom)
watch(streamingBlocksLen, scrollToBottom)
</script>

<template>
  <div class="message-list" ref="scrollContainer">
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
