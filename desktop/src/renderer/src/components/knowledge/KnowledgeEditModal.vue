<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'
import { KB_DESC_MAX, KB_NAME_MAX, validateKbDesc, validateKbName } from './knowledgeNaming'

/**
 * 知识库编辑弹窗（名称 + 描述）
 *
 * 只改页面内的列表数据（当前知识库列表是 mock，无主进程存储）；
 * 按知识库配置以 id 为键，改名不影响配置。
 */
const props = defineProps<{
  open: boolean
  library: { id: string; name: string; description: string } | null
}>()

const emit = defineEmits<{
  close: []
  saved: [name: string, description: string]
}>()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
const name = ref('')
const description = ref('')
const error = ref('')

watch(
  () => [props.open, props.library?.id] as const,
  ([open]) => {
    visible.value = open
    if (open && props.library) {
      name.value = props.library.name
      description.value = props.library.description
      error.value = ''
    }
  },
  { immediate: true }
)

function onSave(): void {
  const nameError = validateKbName(name.value)
  if (nameError) {
    error.value = nameError
    return
  }
  const descError = validateKbDesc(description.value)
  if (descError) {
    error.value = descError
    return
  }
  emit('saved', name.value.trim(), description.value.trim())
  emit('close')
}

function closeModal(): void {
  emit('close')
}
</script>

<template>
  <ModalShell :visible="visible" aria-label="编辑知识库" @close="closeModal">
    <template #header>
      <span class="ke-title">知识库编辑</span>
    </template>

    <div class="ke-body">
      <label class="ke-field">
        <span class="ke-label">名称</span>
        <input
          v-model="name"
          class="ke-input"
          :maxlength="KB_NAME_MAX"
          placeholder="请输入知识库名称"
        />
      </label>
      <label class="ke-field">
        <span class="ke-label">描述</span>
        <textarea
          v-model="description"
          class="ke-input ke-textarea"
          :maxlength="KB_DESC_MAX"
          rows="3"
          placeholder="简单说明这个知识库的用途"
        />
      </label>
      <p v-if="error" class="ke-error">
        {{ error }}
      </p>
    </div>

    <template #footer>
      <button class="ke-btn" type="button" @click="closeModal">取消</button>
      <button class="ke-btn ke-btn--primary" type="button" @click="onSave">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.ke-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ke-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px;
}

.ke-field {
  display: block;
  min-width: 0;
}

.ke-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ke-input {
  display: block;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
  font-size: 14px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
}

.ke-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.ke-textarea {
  height: auto;
  padding: 10px 12px;
  line-height: 1.6;
  resize: vertical;
}

.ke-error {
  font-size: 12px;
  color: #cf625b;
}

.ke-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.ke-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.ke-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.ke-btn--primary:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
</style>
