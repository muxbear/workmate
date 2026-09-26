<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, Link2, MessagesSquare, Search, Sparkles, X } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'

/** 会话标题栏：标题、对话内搜索、分享、历史提问、执行过程开关（对齐桌面版「新建任务」标题栏）。 */
const chatStore = useChatStore()
const uiStore = useUiStore()

const searchOpen = ref(false)

const historyOpen = ref(false)
const copiedTip = ref('')

const title = computed(() => {
  const current = uiStore.histories.find((item) => item.thread_id === uiStore.activeThreadId)
  return current?.title || '新对话'
})

const userQuestions = computed(() =>
  chatStore.messages.filter((message) => message.role === 'user'),
)

const matchIds = computed(() => chatStore.searchMatchIds)

const searchIndex = ref(0)

function scrollToMessage(id: number) {
  const el = document.querySelector('[data-msg-id=' + JSON.stringify(id) + ']')
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function gotoSearch(direction: 1 | -1) {
  if (matchIds.value.length === 0) return
  const next = (searchIndex.value + direction + matchIds.value.length) % matchIds.value.length
  searchIndex.value = next
  scrollToMessage(matchIds.value[next])
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) {
    chatStore.searchKeyword = ''
    searchIndex.value = 0
  }
}

function jumpToQuestion(id: number) {
  historyOpen.value = false
  scrollToMessage(id)
}

async function copyText(text: string, tip: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedTip.value = tip
  } catch {
    copiedTip.value = '复制失败'
  }
  setTimeout(() => (copiedTip.value = ''), 2000)
}

function toggleSharePanel() {
  if (chatStore.shareMode) chatStore.closeSharePanel()
  else chatStore.openSharePanel()
}

function toggleTrace() {
  chatStore.traceEnabled = !chatStore.traceEnabled
}
</script>

<template>
  <div class="chat-header">
    <div class="header-left">
      <span class="header-avatar"><Sparkles :size="16" /></span>
      <span class="header-title">{{ title }}</span>
    </div>
    <div class="header-right">
      <div v-if="searchOpen" class="search-bar">
        <Search :size="13" />
        <input
          v-model="chatStore.searchKeyword"
          class="search-input"
          placeholder="搜索当前对话"
          @keydown.enter.prevent="gotoSearch(1)"
        />
        <span class="search-count"
          >{{ matchIds.length ? searchIndex + 1 : 0 }}/{{ matchIds.length }}</span
        >
        <button
          class="icon-btn"
          title="上一条"
          :disabled="!matchIds.length"
          @click="gotoSearch(-1)"
        >
          上
        </button>
        <button class="icon-btn" title="下一条" :disabled="!matchIds.length" @click="gotoSearch(1)">
          下
        </button>
        <button class="icon-btn" title="关闭" @click="toggleSearch" aria-label="关闭"><X :size="13" /></button>
      </div>
      <button
        class="icon-btn"
        :class="{ active: searchOpen }"
        title="对话内搜索"
        @click="toggleSearch"
       aria-label="对话内搜索">
        <Search :size="15" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: chatStore.shareMode }"
        title="分享"
        @click="toggleSharePanel"
       aria-label="分享">
        <Link2 :size="15" />
      </button>
      <div class="menu-wrap">
        <button
          class="icon-btn"
          :class="{ active: historyOpen }"
          title="历史提问"
          @click="historyOpen = !historyOpen"
         aria-label="历史提问">
          <MessagesSquare :size="15" />
          <ChevronDown :size="12" />
        </button>
        <div v-if="historyOpen" class="dropdown dropdown--wide">
          <p class="dropdown-title">历史提问 ({{ userQuestions.length }})</p>
          <button
            v-for="question in userQuestions"
            :key="question.id"
            class="dropdown-item dropdown-item--question"
            @click="jumpToQuestion(question.id)"
          >
            {{ question.content }}
          </button>
          <p v-if="userQuestions.length === 0" class="dropdown-empty">暂无提问</p>
        </div>
      </div>
      <button
        class="trace-btn"
        :class="{ active: chatStore.traceEnabled }"
        title="展示执行过程"
        @click="toggleTrace"
      >
        执行过程
      </button>
      <span v-if="copiedTip" class="copy-tip">{{ copiedTip }}</span>
    </div>
  </div>
</template>

<style scoped>
.chat-header {
  height: var(--chat-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  background: var(--surface-card);
  border-bottom: 1px solid var(--border-subtle);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--accent-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled),
.icon-btn.active {
  background: var(--surface-secondary);
  color: var(--accent-primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-muted);
}

.search-input {
  width: 150px;
  border: none;
  background: transparent;
  outline: none;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
}

.search-count {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.menu-wrap {
  position: relative;
}

.dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 170px;
  padding: 4px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dropdown--wide {
  max-height: 280px;
  overflow-y: auto;
  min-width: 240px;
}

.dropdown-title {
  margin: 0;
  padding: 6px 8px 2px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.dropdown-item {
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.dropdown-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.dropdown-item--question {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-empty {
  margin: 0;
  padding: 8px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.trace-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.trace-btn.active {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  background: var(--accent-primary-light);
}

.copy-tip {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  padding: 4px 10px;
  border-radius: var(--radius-lg);
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  font-size: var(--font-size-xs);
  white-space: nowrap;
}
</style>
