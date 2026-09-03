<script setup lang="ts">
import { computed } from 'vue'
import { Sparkles } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import MessageList from './MessageList.vue'
import InputBar from './InputBar.vue'

const chatStore = useChatStore()

// 欢迎态：无任何消息时显示；发送首条消息或加载历史对话后自动切换为对话态
const isWelcome = computed(() => chatStore.messages.length === 0)
</script>

<template>
  <div class="chat-main">
    <!-- 欢迎态 -->
    <div v-if="isWelcome" class="welcome-state">
      <div class="welcome-content">
        <div class="welcome-icon">
          <Sparkles :size="40" />
        </div>
        <h1 class="welcome-title">Hermes 助手，有什么可以帮你？</h1>
        <p class="welcome-subtitle">输入消息开始对话，或从右侧历史记录中选择已有对话</p>
      </div>
      <div class="welcome-input">
        <InputBar />
      </div>
    </div>

    <!-- 对话态 -->
    <template v-else>
      <MessageList />
      <div class="chat-input">
        <InputBar />
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-primary);
}

/* ===== 欢迎态 ===== */
.welcome-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
}

.welcome-content {
  text-align: center;
  margin-bottom: 28px;
}

.welcome-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-full);
  background: var(--accent-primary);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  box-shadow: var(--shadow-logo);
}

.welcome-title {
  font-size: 22px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin: 0 0 6px;
}

.welcome-subtitle {
  font-size: var(--font-size-md);
  color: var(--foreground-muted);
  margin: 0;
}

.welcome-input {
  width: 100%;
  max-width: 720px;
}

.welcome-input :deep(.input-bar) {
  padding: 0;
  background: transparent;
  border-top: none;
}

.welcome-input :deep(.input-area) {
  background: #fff;
}

/* ===== 对话态输入框 ===== */
.chat-input {
  padding: 0 48px;
}

.chat-input :deep(.input-bar) {
  background: transparent;
  border-top: none;
}

.chat-input :deep(.input-area) {
  background: #fff;
}
</style>
