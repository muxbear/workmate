<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ChatInputPart } from '@/types/chat'

/**
 * 富文本输入框：支持文本 + 技能标记 + 文件标记（对齐桌面版「新建任务」输入卡）。
 * 标记以 contenteditable=false 的内联 span 呈现，序列化后得到「文本段 + 文件段」保序部件。
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    disabled?: boolean
    parts?: ChatInputPart[]
  }>(),
  {
    placeholder: '输入消息...',
    disabled: false,
    parts: () => [],
  },
)

const emit = defineEmits<{
  'update:parts': [parts: ChatInputPart[]]
  submit: []
  'remove-skill': [id: string]
  'remove-attachment': [attachmentId: string]
  files: [files: File[]]
}>()

const el = ref<HTMLElement | null>(null)
const composing = ref(false)

const placeholderText = computed(() => props.placeholder)

function pushText(parts: ChatInputPart[], text: string) {
  if (!text) return
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') last.text += text
  else parts.push({ type: 'text', text })
}

/** DOM → 保序部件（技能标记序列化为 /技能名，文件标记序列化为文件段） */
function serialize(): ChatInputPart[] {
  const root = el.value
  if (!root) return []
  const parts: ChatInputPart[] = []
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(parts, node.textContent ?? '')
    } else if (node instanceof HTMLElement && node.classList.contains('skill-token')) {
      pushText(parts, '/' + (node.dataset.name ?? ''))
    } else if (node instanceof HTMLElement && node.classList.contains('file-token')) {
      const attachmentId = node.dataset.attachmentId
      if (attachmentId) {
        parts.push({ type: 'file', attachmentId, filename: node.dataset.name ?? '' })
      }
    } else if (node.nodeName === 'BR') {
      pushText(parts, '\n')
    } else if (node instanceof HTMLElement) {
      pushText(parts, node.textContent ?? '')
    }
  }
  return parts
}

function sync() {
  emit('update:parts', serialize())
}

/** 取当前光标位置（不在输入框内时追加到末尾） */
function caretRange(root: HTMLElement): Range {
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0 && root.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0)
    range.collapse(false)
    return range
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  return range
}

function makeToken(kind: 'skill' | 'file', key: string, name: string): HTMLElement {
  const token = document.createElement('span')
  token.className = kind === 'skill' ? 'skill-token' : 'file-token'
  token.contentEditable = 'false'
  token.dataset.name = name
  token.title = kind === 'skill' ? '点击移除技能' : '点击移除文件'
  if (kind === 'skill') token.dataset.skillId = key
  else token.dataset.attachmentId = key
  const label = document.createElement('span')
  label.className = 'token-label'
  label.textContent = kind === 'skill' ? '/' + name : name
  token.appendChild(label)
  return token
}

function insertToken(token: HTMLElement) {
  const root = el.value
  if (!root) return
  const range = caretRange(root)
  range.insertNode(token)
  const space = document.createTextNode(' ')
  token.after(space)
  range.setStartAfter(space)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  sync()
}

/** 插入技能标记（已存在则忽略） */
function insertSkill(skill: { id: string; name: string }) {
  const root = el.value
  if (!root) return
  const exists = root.querySelector('.skill-token[data-skill-id=' + JSON.stringify(skill.id) + ']')
  if (exists) return
  insertToken(makeToken('skill', skill.id, skill.name))
}

function removeSkillToken(id: string) {
  const root = el.value
  if (!root) return
  root.querySelector('.skill-token[data-skill-id=' + JSON.stringify(id) + ']')?.remove()
  sync()
}

/** 插入文件标记（对应附件已上传成功） */
function insertFileToken(file: { attachmentId: string; filename: string }) {
  const root = el.value
  if (!root) return
  const exists = root.querySelector(
    '.file-token[data-attachment-id=' + JSON.stringify(file.attachmentId) + ']',
  )
  if (exists) return
  insertToken(makeToken('file', file.attachmentId, file.filename))
}

/** 用保序部件重建输入内容（编辑任务时回填文本段与文件标记） */
function setParts(parts: ChatInputPart[]) {
  const root = el.value
  if (!root) return
  root.innerHTML = ''
  for (const part of parts) {
    if (part.type === 'text') {
      const lines = part.text.split('\n')
      lines.forEach((line, index) => {
        if (index > 0) root.appendChild(document.createElement('br'))
        if (line) root.appendChild(document.createTextNode(line))
      })
    } else {
      root.appendChild(makeToken('file', part.attachmentId, part.filename))
      root.appendChild(document.createTextNode(' '))
    }
  }
  sync()
}
function setText(value: string) {
  const root = el.value
  if (!root) return
  root.textContent = value
  sync()
}

function clear() {
  const root = el.value
  if (root) root.innerHTML = ''
  sync()
}

function focus() {
  void nextTick(() => el.value?.focus())
}

function getText(): string {
  return (el.value?.innerText ?? '').trim()
}

function onInput() {
  const root = el.value
  if (!root) return
  // 内容清空后浏览器可能残留 BR，清掉以恢复占位文案
  if (
    (root.innerText ?? '').trim() === '' &&
    root.querySelector('.skill-token, .file-token') === null
  ) {
    root.innerHTML = ''
  }
  sync()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (composing.value || event.isComposing) return
  event.preventDefault()
  emit('submit')
}

function onTokenClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  const token = target.closest('.skill-token, .file-token')
  if (!(token instanceof HTMLElement)) return
  event.preventDefault()
  const skillId = token.dataset.skillId
  const attachmentId = token.dataset.attachmentId
  token.remove()
  sync()
  if (skillId) emit('remove-skill', skillId)
  if (attachmentId) emit('remove-attachment', attachmentId)
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain')
  if (text === undefined) return
  event.preventDefault()
  document.execCommand('insertText', false, text)
  sync()
}

function onDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  event.preventDefault()
  emit('files', files)
}

defineExpose({
  insertSkill,
  removeSkillToken,
  insertFileToken,
  setText,
  setParts,
  clear,
  focus,
  getText,
})
</script>

<template>
  <div
    ref="el"
    class="rich-input"
    :class="{ 'rich-input--disabled': disabled }"
    :contenteditable="!disabled"
    :data-placeholder="placeholderText"
    @input="onInput"
    @keydown="onKeydown"
    @click="onTokenClick"
    @paste="onPaste"
    @dragover.prevent
    @drop="onDrop"
    @compositionstart="composing = true"
    @compositionend="composing = false"
  ></div>
</template>

<style scoped>
.rich-input {
  width: 100%;
  min-height: 72px;
  max-height: 200px;
  overflow-y: auto;
  padding: 0 16px;
  outline: none;
  color: var(--foreground-primary);
  font-size: var(--font-size-md);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.rich-input:empty::before {
  content: attr(data-placeholder);
  color: var(--foreground-muted);
  pointer-events: none;
}

.rich-input--disabled {
  opacity: 0.6;
}

:deep(.skill-token),
:deep(.file-token) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 2px;
  padding: 1px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
  color: var(--accent-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  white-space: nowrap;
  vertical-align: middle;
}

:deep(.skill-token:hover),
:deep(.file-token:hover) {
  border-color: var(--accent-primary);
  background: var(--accent-primary-light);
}

:deep(.file-token) {
  color: var(--foreground-secondary);
}
</style>
