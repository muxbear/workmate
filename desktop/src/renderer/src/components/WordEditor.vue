<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocxEditor, type DocxEditorRef } from '@docx-editor.dev/react'
import { zhCN } from '@docx-editor.dev/i18n'
import { loadDefaultFonts, type DefaultFontsFragment } from '@docx-editor.dev/fonts'
import { blankDocumentBytes } from '@docx-editor.dev/core/editor'

const props = withDefaults(
  defineProps<{
    /** 主进程读取并返回的 docx 字节。 */
    document?: Uint8Array | ArrayBuffer
    /** 文件标题，显示在 docx-editor 自带标题栏。 */
    title?: string
  }>(),
  {
    document: undefined,
    title: '未命名文档'
  }
)

const mode = defineModel<'view' | 'edit'>('mode', { default: 'view' })

const emit = defineEmits<{
  ready: []
  change: []
  save: [bytes: ArrayBuffer]
  fontError: [error: unknown]
}>()

const host = ref<HTMLDivElement | null>(null)
const editorRef = ref<DocxEditorRef | null>(null)
const fonts = ref<DefaultFontsFragment | null>(null)

const blankDocument = blankDocumentBytes()
let root: Root | null = null

const handleSave = async (): Promise<void> => {
  const bytes = await editorRef.value?.save()
  if (bytes) emit('save', bytes)
}

const renderReact = (): void => {
  if (!host.value) return

  const reactRef = createRef<DocxEditorRef>()
  editorRef.value = null

  const element = createElement(DocxEditor, {
    document: props.document ?? blankDocument,
    mode: mode.value,
    locale: 'zh-CN',
    i18n: zhCN,
    title: props.title,
    fonts: fonts.value ?? undefined,
    ref: reactRef,
    onReady: () => {
      editorRef.value = reactRef.current
      emit('ready')
    },
    onChange: () => emit('change'),
    onFontError: (error: unknown) => emit('fontError', error),
    onSave: () => {
      void handleSave()
    }
  })

  if (root) root.unmount()
  root = createRoot(host.value)
  root.render(element)
}

const loadFonts = async (): Promise<void> => {
  try {
    fonts.value = await loadDefaultFonts()
    renderReact()
  } catch (error) {
    emit('fontError', error)
  }
}

const save = async (): Promise<ArrayBuffer | null> => editorRef.value?.save() ?? null
const focus = (): void => editorRef.value?.focus()

defineExpose({ save, focus })

onMounted(() => {
  renderReact()
  void loadFonts()
})

watch(
  () => [props.document, mode.value],
  () => renderReact()
)

onBeforeUnmount(() => {
  root?.unmount()
  root = null
})
</script>

<template>
  <div class="we">
    <div class="we-toolbar">
      <button
        :class="['we-toolbar-btn', { 'we-toolbar-btn--active': mode === 'view' }]"
        @click="mode = 'view'"
      >
        查看
      </button>
      <button
        :class="['we-toolbar-btn', { 'we-toolbar-btn--active': mode === 'edit' }]"
        @click="mode = 'edit'"
      >
        编辑
      </button>
      <button class="we-toolbar-btn we-toolbar-btn--save" @click="handleSave">保存</button>
    </div>

    <div ref="host" class="we-host" />
  </div>
</template>

<style scoped>
.we {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.we-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(8, 145, 178, 0.1);
  background: #f7f9fb;
  flex-shrink: 0;
}

.we-toolbar-btn {
  border: 1px solid rgba(8, 145, 178, 0.16);
  border-radius: 7px;
  background: #ffffff;
  color: #475569;
  font-size: 12px;
  font-family: inherit;
  padding: 5px 10px;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.we-toolbar-btn:hover {
  background: rgba(8, 145, 178, 0.08);
  color: #0e7490;
}

.we-toolbar-btn--active {
  background: rgba(8, 145, 178, 0.12);
  color: #0891b2;
  border-color: rgba(8, 145, 178, 0.32);
}

.we-toolbar-btn--save {
  margin-left: auto;
  color: #ffffff;
  background: linear-gradient(135deg, #0891b2, #0e7490);
  border: none;
}

.we-toolbar-btn--save:hover {
  opacity: 0.9;
  background: linear-gradient(135deg, #0891b2, #0e7490);
}

.we-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* docx-editor 的标题区把文档名（title）和菜单放在同一个纵向容器里。
   这里只隐藏文档名所在的第一行，保留菜单、工具栏、导航等包装层。 */
.we-host :deep(.docx-editor > div:first-child > div:first-child > div:first-child > :first-child) {
  display: none;
}
</style>
