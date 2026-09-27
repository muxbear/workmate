<script setup lang="ts">
/**
 * 知识库问答标签页。
 *
 * 两个状态：**欢迎态**（还没提问）与**问答态**（已有轮次）。提交问题时先用
 * 「检索」页签同一个接口从选中的知识库取依据，再把「依据 + 问题」交给模型作答，
 * 每条回答下方列出它用到的来源，便于回原文核对。
 *
 * 未选知识库时**不允许提问**：这个面板的承诺是"基于知识库回答"，没有库可检索时
 * 悄悄退化成普通闲聊会让人以为答案有出处。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot, Check, ChevronDown, Copy, Database, FileText, Send, Sparkles, Square, User, Zap,
} from 'lucide-vue-next'
import { useKbQaStore } from '@/stores/kbQa'
import { fetchProviders } from '@/services/modelApi'
import { renderSafeMarkdown } from '@/utils/markdownSafe'
import type { SearchResult } from '@/types/knowledgeBase'

const store = useKbQaStore()
const { t } = useI18n()

const draft = ref('')
const kbOpen = ref(false)
const modelOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const copiedId = ref<string | null>(null)

/** 可选模型（与对话页同一个数据源：模型页启用的 llm / multimodal） */
const models = ref<{ name: string; providerId: string; modelId: string }[]>([])

const kbName = computed(
  () => store.kbOptions.find((kb) => kb.id === store.kbId)?.name ?? '',
)
const modelName = computed(() => store.model ?? t('knowledge.qa.modelDefault'))
const canSend = computed(
  () => !!store.kbId && draft.value.trim().length > 0 && !store.streaming,
)

const SUGGESTIONS = computed(() => [
  t('knowledge.qa.suggest1'),
  t('knowledge.qa.suggest2'),
  t('knowledge.qa.suggest3'),
])

async function loadModels() {
  if (models.value.length) return
  try {
    const providers = await fetchProviders()
    const list: { name: string; providerId: string; modelId: string }[] = []
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        if (model.type !== 'llm' && model.type !== 'multimodal') continue
        if (model.status === 'inactive' || model.status === 'deprecated') continue
        list.push({
          name: model.displayName || model.name,
          providerId: provider.id,
          modelId: model.id,
        })
      }
    }
    models.value = list
  } catch {
    models.value = []
  }
}

function pickKb(id: string) {
  store.setKb(id)
  kbOpen.value = false
}

function pickModel(option: { name: string; providerId: string; modelId: string } | null) {
  if (option) store.setModel(option.name, option.providerId, option.modelId)
  else store.setModel(null, null, null)
  modelOpen.value = false
}

function submit() {
  if (!canSend.value) return
  const question = draft.value
  draft.value = ''
  void store.ask(question)
}

const inputRef = ref<HTMLTextAreaElement | null>(null)

/** 建议问题先落进输入框而不是直接发出去：用户多半想改一改再问 */
function useSuggestion(text: string) {
  draft.value = text
  void nextTick(() => inputRef.value?.focus())
}

function onKeydown(event: KeyboardEvent) {
  // Enter 发送、Shift+Enter 换行（与对话页输入框一致）
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

async function copyTurn(id: string, content: string) {
  try {
    await navigator.clipboard.writeText(content)
    copiedId.value = id
    setTimeout(() => { copiedId.value = null }, 2000)
  } catch {
    // 剪贴板不可用（非 https / 无权限）时静默忽略
  }
}

function sourceLabel(source: SearchResult): string {
  return [source.section, source.page ? t('knowledge.qa.page', { n: source.page }) : '']
    .filter(Boolean)
    .join(' · ')
}

function onDocumentClick(event: MouseEvent) {
  if (!rootRef.value?.contains(event.target as Node)) {
    kbOpen.value = false
    modelOpen.value = false
  }
}

/** 新内容进来时贴住底部（用户自己往上翻时不做处理，交给滚动条） */
function scrollToBottom() {
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(
  () => store.turns.length,
  () => void nextTick(scrollToBottom),
)
watch(
  () => store.turns[store.turns.length - 1]?.content,
  () => void nextTick(scrollToBottom),
)

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  void store.loadKbOptions()
  void loadModels()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <div ref="rootRef" class="qa-tab">
    <!-- 工具条：选库 + 选模型（+ 有会话时的重开入口） -->
    <div class="qa-toolbar">
      <div class="picker">
        <button
          class="picker-btn"
          :title="t('knowledge.qa.kbPlaceholder')"
          @click="kbOpen = !kbOpen"
        >
          <Database :size="13" />
          <span class="picker-text">{{ kbName || t('knowledge.qa.kbPlaceholder') }}</span>
          <ChevronDown :size="12" />
        </button>
        <div v-if="kbOpen" class="picker-menu">
          <button
            v-for="kb in store.kbOptions"
            :key="kb.id"
            class="picker-option"
            :class="{ active: kb.id === store.kbId }"
            @click="pickKb(kb.id)"
          >
            <Check v-if="kb.id === store.kbId" :size="12" />
            <span class="picker-option-name">{{ kb.name }}</span>
          </button>
          <p v-if="!store.kbOptions.length" class="picker-empty">
            {{ t('knowledge.qa.kbEmpty') }}
          </p>
        </div>
      </div>

      <div class="picker">
        <button
          class="picker-btn"
          :title="t('knowledge.qa.modelPlaceholder')"
          @click="modelOpen = !modelOpen"
        >
          <Zap :size="13" />
          <span class="picker-text">{{ modelName }}</span>
          <ChevronDown :size="12" />
        </button>
        <div v-if="modelOpen" class="picker-menu picker-menu--right">
          <button
            class="picker-option"
            :class="{ active: !store.model }"
            @click="pickModel(null)"
          >
            <Check v-if="!store.model" :size="12" />
            <span class="picker-option-name">{{ t('knowledge.qa.modelDefault') }}</span>
          </button>
          <button
            v-for="option in models"
            :key="option.providerId + option.modelId"
            class="picker-option"
            :class="{ active: store.model === option.name }"
            @click="pickModel(option)"
          >
            <Check v-if="store.model === option.name" :size="12" />
            <span class="picker-option-name">{{ option.name }}</span>
          </button>
          <p v-if="!models.length" class="picker-empty">{{ t('knowledge.qa.modelEmpty') }}</p>
        </div>
      </div>

      <button
        v-if="store.turns.length"
        class="qa-new-btn"
        :title="t('knowledge.qa.newChat')"
        @click="store.reset()"
      >
        {{ t('knowledge.qa.newChat') }}
      </button>
    </div>

    <div ref="scrollRef" class="qa-main">
      <!-- 欢迎态 -->
      <div v-if="!store.turns.length" class="qa-welcome">
        <div class="welcome-icon"><Sparkles :size="22" /></div>
        <h2 class="welcome-title">{{ t('knowledge.qa.welcomeTitle') }}</h2>
        <p class="welcome-desc">{{ t('knowledge.qa.welcomeDesc') }}</p>
        <div class="welcome-suggestions">
          <button
            v-for="item in SUGGESTIONS"
            :key="item"
            class="suggestion"
            @click="useSuggestion(item)"
          >
            {{ item }}
          </button>
        </div>
        <p v-if="!store.kbId" class="welcome-hint">{{ t('knowledge.qa.emptyKbHint') }}</p>
      </div>

      <!-- 问答态 -->
      <div v-else class="qa-thread">
        <div
          v-for="turn in store.turns"
          :key="turn.id"
          class="qa-turn"
          :class="`qa-turn--${turn.role}`"
        >
          <div class="turn-avatar">
            <User v-if="turn.role === 'user'" :size="13" />
            <Bot v-else :size="13" />
          </div>
          <div class="turn-body">
            <p v-if="turn.role === 'user'" class="turn-text">{{ turn.content }}</p>

            <template v-else>
              <p v-if="turn.retrieveError" class="turn-note turn-note--warn">
                {{ t('knowledge.qa.retrieveFailed', { reason: turn.retrieveError }) }}
              </p>
              <p v-else-if="turn.noRelevant" class="turn-note">
                {{ t('knowledge.qa.noRelevant') }}
              </p>

              <div
                v-if="turn.content"
                class="turn-markdown"
                v-html="renderSafeMarkdown(turn.content)"
              />
              <p v-else-if="turn.pending" class="turn-note">
                {{ t('knowledge.qa.thinking') }}
              </p>
              <p v-if="turn.error" class="turn-note turn-note--error">{{ turn.error }}</p>

              <!-- 来源：检索到什么就列什么，点开可看切片原文 -->
              <div v-if="turn.sources.length" class="turn-sources">
                <div class="sources-title">
                  <FileText :size="12" />
                  {{ t('knowledge.qa.sources', { n: turn.sources.length }) }}
                </div>
                <details
                  v-for="(source, index) in turn.sources"
                  :key="source.id"
                  class="source-item"
                >
                  <summary class="source-head">
                    <span class="source-index">[{{ index + 1 }}]</span>
                    <span class="source-name">{{ source.doc }}</span>
                    <span v-if="sourceLabel(source)" class="source-where">
                      {{ sourceLabel(source) }}
                    </span>
                  </summary>
                  <p class="source-chunk">{{ source.chunk }}</p>
                </details>
              </div>

              <div v-if="turn.content" class="turn-actions">
                <button class="turn-action" @click="copyTurn(turn.id, turn.content)">
                  <Check v-if="copiedId === turn.id" :size="12" />
                  <Copy v-else :size="12" />
                  {{ copiedId === turn.id ? t('knowledge.qa.copied') : t('knowledge.qa.copy') }}
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="qa-composer">
      <textarea
        ref="inputRef"
        v-model="draft"
        class="composer-input"
        rows="3"
        :placeholder="store.kbId
          ? t('knowledge.qa.inputPlaceholder')
          : t('knowledge.qa.pickKbFirst')"
        :disabled="!store.kbId"
        @keydown="onKeydown"
      />
      <div class="composer-bar">
        <span class="composer-hint">{{ t('knowledge.qa.sendHint') }}</span>
        <button
          v-if="store.streaming"
          class="composer-btn composer-btn--stop"
          :title="t('knowledge.qa.stop')"
          @click="store.stop()"
        >
          <Square :size="13" />{{ t('knowledge.qa.stop') }}
        </button>
        <button
          v-else
          class="composer-btn"
          :disabled="!canSend"
          :title="t('knowledge.qa.send')"
          @click="submit"
        >
          <Send :size="13" />{{ t('knowledge.qa.send') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qa-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ── 工具条 ── */
.qa-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  flex-shrink: 0;
}

.picker {
  position: relative;
  min-width: 0;
}

.picker-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 5px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.picker-btn:hover {
  color: var(--foreground-primary);
  border-color: var(--border-medium);
}

.picker-text {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 200;
  min-width: 180px;
  max-width: 280px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
}

/* 靠右的那个（模型）贴右边展开，避免越出面板 */
.picker-menu--right {
  left: auto;
  right: 0;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.picker-option:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.picker-option.active {
  color: var(--accent-primary);
}

.picker-option svg {
  flex-shrink: 0;
}

.picker-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-empty {
  margin: 0;
  padding: 8px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.qa-new-btn {
  margin-left: auto;
  padding: 5px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
}

.qa-new-btn:hover {
  color: var(--foreground-primary);
  border-color: var(--border-medium);
}

/* ── 主体 ── */
.qa-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.qa-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 16px;
  text-align: center;
}

.welcome-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
}

.welcome-title {
  margin: 14px 0 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.welcome-desc {
  margin: 6px 0 0;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  line-height: 1.7;
}

.welcome-suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  margin-top: 18px;
}

.suggestion {
  padding: 9px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}

.suggestion:hover {
  color: var(--foreground-primary);
  border-color: rgba(59, 130, 246, 0.4);
}

.welcome-hint {
  margin: 18px 0 0;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

/* ── 轮次 ── */
.qa-thread {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 8px;
}

.qa-turn {
  display: flex;
  gap: 8px;
}

.turn-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.qa-turn--assistant .turn-avatar {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(139, 92, 246, 0.2));
  color: #93c5fd;
}

.turn-body {
  min-width: 0;
  flex: 1;
}

.qa-turn--user .turn-body {
  background: rgba(59, 130, 246, 0.1);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
}

.turn-text {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.turn-note {
  margin: 0 0 6px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.turn-note--warn {
  color: var(--status-warning-text, #f59e0b);
}

.turn-note--error {
  color: var(--status-error-text, #f87171);
}

.turn-markdown {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  line-height: 1.75;
  word-break: break-word;
}

.turn-markdown :deep(p) {
  margin: 0 0 8px;
}

.turn-markdown :deep(pre) {
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  overflow-x: auto;
}

.turn-markdown :deep(code) {
  font-size: var(--font-size-xs);
}

.turn-markdown :deep(ul),
.turn-markdown :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}

/* ── 来源 ── */
.turn-sources {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sources-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.source-item {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  overflow: hidden;
}

.source-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  cursor: pointer;
}

.source-index {
  flex-shrink: 0;
  color: var(--accent-primary);
}

.source-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-where {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--foreground-muted);
}

.source-chunk {
  margin: 0;
  padding: 0 10px 10px;
  font-size: var(--font-size-xs);
  color: var(--foreground-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.turn-actions {
  margin-top: 6px;
}

.turn-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
}

.turn-action:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

/* ── 输入区 ── */
.qa-composer {
  flex-shrink: 0;
  margin-top: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  padding: 8px;
}

.composer-input {
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  line-height: 1.6;
}

.composer-input::placeholder {
  color: var(--foreground-muted);
}

.composer-input:disabled {
  cursor: not-allowed;
}

.composer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.composer-hint {
  font-size: 10px;
  color: var(--foreground-muted);
}

.composer-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: none;
  border-radius: var(--radius-input);
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  color: #fff;
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
}

.composer-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer-btn--stop {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  border: 1px solid var(--border-medium);
}
</style>
