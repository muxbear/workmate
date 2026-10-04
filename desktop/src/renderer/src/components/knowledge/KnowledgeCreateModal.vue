<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'
import { KB_DESC_MAX, KB_NAME_MAX, validateKbDesc, validateKbName } from './knowledgeNaming'

/**
 * 新建知识库弹窗（名称 + 描述）
 *
 * 只负责收集与本地校验，落盘交给父级（store → 主进程）；
 * 名称/描述上限与主进程 KnowledgeService 保持一致。
 */
const props = defineProps<{
  open: boolean
  /** 目标分组对应的本地 kind：local / shared（云端建库不在桌面端提供） */
  kind?: 'local' | 'shared' | 'cloud'
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { name: string; description: string }]
}>()

const KIND_LABEL: Record<string, string> = {
  local: '本地知识库',
  shared: '我的共享知识',
  // 历史 kind：老数据里可能还有 kind='cloud' 的本地库（已由主进程一次性归一为 local）
  cloud: '本地知识库'
}

const visible = ref(props.open)
const name = ref('')
const description = ref('')
const error = ref('')

watch(
  () => props.open,
  (open) => {
    visible.value = open
    if (open) {
      name.value = ''
      description.value = ''
      error.value = ''
    }
  },
  { immediate: true }
)

function onSubmit(): void {
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
  emit('submit', { name: name.value.trim(), description: description.value.trim() })
  emit('close')
}

function closeModal(): void {
  emit('close')
}
</script>

<template>
  <ModalShell :visible="visible" aria-label="新建知识库" @close="closeModal">
    <template #header>
      <div>
        <span class="kc-title">新建知识库</span>
        <p class="kc-subtitle">将创建到「{{ KIND_LABEL[kind ?? 'local'] }}」</p>
      </div>
    </template>

    <div class="kc-body">
      <label class="kc-field">
        <span class="kc-label">名称</span>
        <input
          v-model="name"
          class="kc-input"
          :maxlength="KB_NAME_MAX"
          placeholder="例如：产品资料库"
          @keydown.enter.prevent="onSubmit"
        />
      </label>
      <label class="kc-field">
        <span class="kc-label">描述（可选）</span>
        <textarea
          v-model="description"
          class="kc-input kc-textarea"
          :maxlength="KB_DESC_MAX"
          rows="3"
          placeholder="简单说明这个知识库的用途"
        />
      </label>
      <p v-if="error" class="kc-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="kc-btn" type="button" @click="closeModal">取消</button>
      <button class="kc-btn kc-btn--primary" type="button" @click="onSubmit">创建</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.kc-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kc-subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.kc-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px;
}

.kc-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.kc-input {
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

.kc-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kc-textarea {
  height: auto;
  padding: 10px 12px;
  line-height: 1.6;
  resize: vertical;
}

.kc-error {
  margin: 0;
  font-size: 12px;
  color: #cf625b;
}

.kc-btn {
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
}

.kc-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.kc-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.kc-btn--primary:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
</style>
