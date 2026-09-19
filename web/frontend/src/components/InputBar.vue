<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ArrowUp, Paperclip, Plus, Sparkles, Square, X } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { polishText } from '@/services/request'
import ChatPlusMenu from './chat/ChatPlusMenu.vue'
import ModelSelector from './chat/ModelSelector.vue'
import PermissionMenu from './chat/PermissionMenu.vue'
import WorkspaceSelector from './chat/WorkspaceSelector.vue'
import RichInput from './chat/RichInput.vue'
import type { ChatInputPart } from '@/types/chat'
import type { Skill } from '@/types/skill'

/**
 * 消息输入卡（对齐桌面版「新建任务」输入卡）：
 * 「+」上拉菜单（添加文件 / 模式 / 专家 / 技能 / 连接器）+ 富文本输入（技能/文件标记）+ 模型选择 + 发送。
 */
const chatStore = useChatStore()
const { selection, inputParts, attachments } = storeToRefs(chatStore)
const router = useRouter()

const plusOpen = ref(false)
const polishing = ref(false)
// 改写前原文，用于「撤销」与「重试」
const polishBackup = ref<{ original: string; result: string } | null>(null)
const toast = ref('')
const placeholder = '输入消息，或点击「+」添加文件、专家、技能…'
const fileInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
const richInputRef = ref<InstanceType<typeof RichInput> | null>(null)

const inputText = computed(() =>
  inputParts.value
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string }).text)
    .join(''),
)

const canSend = computed(() => {
  const hasText = inputText.value.trim().length > 0
  const hasFile = inputParts.value.some((part) => part.type === 'file')
  return hasText || hasFile || chatStore.activeAttachmentIds.length > 0
})

const pendingAttachments = computed(() =>
  attachments.value.filter((item) => item.status !== 'success'),
)

const modeLabel = computed(() => {
  if (selection.value.mode === 'files') return '引用上传文件'
  if (selection.value.mode === 'knowledge') return '引用知识库'
  return '默认'
})

const hasChips = computed(
  () =>
    Boolean(selection.value.expertName) ||
    selection.value.mode !== 'default' ||
    selection.value.kbIds.length > 0,
)

function onPartsUpdate(parts: ChatInputPart[]) {
  chatStore.setInputParts(parts)
  // 用户手动修改内容后失效改写记录（撤销/重试入口随之隐藏）
  if (polishBackup.value) {
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { type: 'text'; text: string }).text)
      .join('')
    if (text !== polishBackup.value.result) polishBackup.value = null
  }
}

function openPicker(kind: 'file' | 'image') {
  plusOpen.value = false
  if (kind === 'image') imageInputRef.value?.click()
  else fileInputRef.value?.click()
}

async function addFiles(files: File[]) {
  for (const file of files) {
    const before = new Set(attachments.value.map((item) => item.id))
    await chatStore.uploadFile(file)
    const added = attachments.value.find((item) => !before.has(item.id))
    if (added?.serverId) {
      richInputRef.value?.insertFileToken({
        attachmentId: added.serverId,
        filename: added.filename,
      })
    }
  }
}

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length > 0) await addFiles(files)
}

function onRemoveAttachment(attachmentId: string) {
  const target = attachments.value.find((item) => item.serverId === attachmentId)
  if (target) chatStore.removeAttachment(target.id)
}

function onToggleSkill(skill: Skill) {
  const willSelect = !selection.value.skillIds.includes(skill.id)
  chatStore.toggleSkillId(skill.id)
  if (willSelect) richInputRef.value?.insertSkill({ id: skill.id, name: skill.name })
  else richInputRef.value?.removeSkillToken(skill.id)
}

async function handlePolish() {
  const current = richInputRef.value?.getText() ?? ''
  if (!current.trim()) {
    showToast('请先输入要改写的内容')
    return
  }
  if (polishing.value) return
  polishing.value = true
  try {
    const polished = await polishText(current)
    if (polished) {
      richInputRef.value?.setText(polished)
      polishBackup.value = { original: current, result: polished }
    }
  } catch {
    showToast('改写失败，请稍后重试')
  } finally {
    polishing.value = false
  }
}

/** 撤销改写：恢复改写前原文 */
function undoPolish() {
  if (!polishBackup.value) return
  richInputRef.value?.setText(polishBackup.value.original)
  polishBackup.value = null
}

/** 重试改写：以原文重新请求一次 */
async function retryPolish() {
  if (!polishBackup.value) return
  richInputRef.value?.setText(polishBackup.value.original)
  polishBackup.value = null
  await handlePolish()
}

function showToast(message: string) {
  toast.value = message
  setTimeout(() => (toast.value = ''), 1800)
}

function handleSend() {
  if (chatStore.loading || !canSend.value) return
  chatStore.sendMessage(inputText.value)
  richInputRef.value?.clear()
  polishBackup.value = null
}

function handleDropFiles(files: File[]) {
  void addFiles(files)
}

function onNavigate(path: string) {
  plusOpen.value = false
  void router.push(path)
}

function handleDocumentClick(event: MouseEvent) {
  if (!plusOpen.value) return
  const target = event.target as HTMLElement
  if (target.closest('.plus-menu') || target.closest('[data-plus-trigger]')) return
  plusOpen.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleDocumentClick)
})

watch(
  () => chatStore.loading,
  (loading) => {
    if (!loading) richInputRef.value?.focus()
  },
)
</script>

<template>
  <div class="input-bar">
    <div class="input-area">
      <div v-if="hasChips" class="selection-chips">
        <span v-if="selection.expertName" class="chip" @click="chatStore.setExpert(null)">
          {{ selection.expertName }}
          <X :size="10" />
        </span>
        <span
          v-if="selection.mode !== 'default'"
          class="chip"
          @click="chatStore.setMode('default')"
        >
          模式 · {{ modeLabel }}
          <X :size="10" />
        </span>
        <span
          v-if="selection.kbIds.length > 0"
          class="chip"
          @click="chatStore.setSelection({ kbIds: [] })"
        >
          知识库 · 已选 {{ selection.kbIds.length }} 个
          <X :size="10" />
        </span>
      </div>

      <div v-if="pendingAttachments.length > 0" class="pending-attachments">
        <span
          v-for="item in pendingAttachments"
          :key="item.id"
          class="pending-item"
          :class="{ 'pending-item--failed': item.status === 'failed' }"
          @click="item.status === 'failed' && chatStore.retryUpload(item.id)"
        >
          {{ item.filename }}
          <span v-if="item.status === 'uploading'">{{ item.progress }}%</span>
          <X :size="10" @click.stop="chatStore.removeAttachment(item.id)" />
        </span>
      </div>

      <RichInput
        ref="richInputRef"
        :parts="inputParts"
        :disabled="chatStore.loading"
        :placeholder="placeholder"
        @update:parts="onPartsUpdate"
        @submit="handleSend"
        @remove-attachment="onRemoveAttachment"
        @files="handleDropFiles"
      />

      <div class="input-toolbar">
        <div class="tool-btn-wrap">
          <button
            class="tool-btn"
            data-plus-trigger
            title="添加文件 / 专家 / 技能 / 连接器"
            @click.stop="plusOpen = !plusOpen"
          >
            <Plus :size="16" />
          </button>
          <ChatPlusMenu
            v-if="plusOpen"
            @close="plusOpen = false"
            @pick-files="openPicker"
            @toggle-skill="onToggleSkill"
            @navigate="onNavigate"
          />
        </div>
        <button class="tool-btn" title="上传本地文件" @click="openPicker('file')">
          <Paperclip :size="16" />
        </button>
        <button
          class="tool-btn"
          :class="{ 'tool-btn--polishing': polishing }"
          title="AI 改写润色"
          :disabled="polishing"
          @click="handlePolish"
        >
          <Sparkles :size="16" />
        </button>
        <div v-if="polishBackup" class="polish-chip">
          <span class="polish-chip-text">已改写</span>
          <button class="polish-chip-btn" @click="undoPolish">撤销</button>
          <button class="polish-chip-btn" :disabled="polishing" @click="retryPolish">重试</button>
        </div>
        <div class="toolbar-spacer"></div>
        <ModelSelector />
        <button v-if="!chatStore.loading" class="send-btn" :disabled="!canSend" @click="handleSend">
          <ArrowUp :size="18" />
        </button>
        <button v-else class="stop-btn" title="停止生成" @click="chatStore.stopGeneration()">
          <Square :size="14" />
        </button>
      </div>

      <div class="input-footer">
        <WorkspaceSelector />
        <PermissionMenu />
        <div class="footer-spacer" />
      </div>

      <Transition name="fade">
        <div v-if="toast" class="input-toast">{{ toast }}</div>
      </Transition>
      <input
        ref="fileInputRef"
        type="file"
        data-attachment-input
        multiple
        hidden
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.py,.java,.csv,.md,.json,.xml,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.bmp"
        @change="onFilesSelected"
      />
      <input
        ref="imageInputRef"
        type="file"
        multiple
        hidden
        accept="image/*"
        @change="onFilesSelected"
      />
    </div>
  </div>
</template>

<style scoped>
.input-bar {
  padding: 12px 24px 16px;
  background: var(--surface-card);
  border-top: 1px solid var(--border-subtle);
}

.input-area {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  background: var(--surface-secondary);
}

.selection-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: var(--surface-card);
  color: var(--accent-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.chip:hover {
  border-color: var(--accent-primary);
}

.pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px;
}

.pending-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-full);
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.pending-item--failed {
  border-color: #ef4444;
  color: #ef4444;
  cursor: pointer;
}

.input-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
}

.tool-btn-wrap {
  position: relative;
}

.toolbar-spacer {
  flex: 1;
}

.tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover {
  background: rgba(59, 130, 246, 0.1);
  color: var(--foreground-primary);
}

.send-btn,
.stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--accent-primary);
  color: #fff;
  cursor: pointer;
  transition: all 0.15s;
  margin-left: 2px;
}

.send-btn:disabled {
  background: rgba(59, 130, 246, 0.2);
  color: var(--foreground-muted);
  cursor: not-allowed;
}

.stop-btn:hover {
  background: #dc2626;
}

.input-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 0;
  border-top: 1px solid var(--border-subtle);
}

.footer-spacer {
  flex: 1;
}

.tool-btn--polishing svg {
  animation: polish-spin 0.8s linear infinite;
}

@keyframes polish-spin {
  to {
    transform: rotate(360deg);
  }
}

.input-toast {
  position: fixed;
  left: 50%;
  bottom: 110px;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: var(--radius-lg);
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  font-size: var(--font-size-xs);
  z-index: 250;
  pointer-events: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.polish-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
  font-size: var(--font-size-xs);
}

.polish-chip-text {
  color: var(--accent-primary);
}

.polish-chip-btn {
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  padding: 0;
}

.polish-chip-btn:hover:not(:disabled) {
  color: var(--accent-primary);
}

.polish-chip-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
