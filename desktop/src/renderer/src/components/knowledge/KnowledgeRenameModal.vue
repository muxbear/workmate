<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'
import { validateName } from './knowledgeNaming'

/**
 * 通用重命名弹窗（知识库 / 文件夹 / 文件共用）
 *
 * 只改页面内的 mock 数据（知识库列表与文件列表都没有主进程存储）；
 * 文件树以「/」分层，所以名称里不允许出现斜杠，否则会破坏目录结构。
 */
const props = defineProps<{
  open: boolean
  /** 弹窗标题 */
  title?: string
  /** 输入框上方的字段名 */
  label?: string
  /** 打开时的名称 */
  current: string
  /** 重命名对象说明（副标题） */
  hint?: string
  /** 名称长度上限 */
  maxlength?: number
}>()

const emit = defineEmits<{
  close: []
  submit: [name: string]
}>()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
const name = ref('')
const error = ref('')

watch(
  () => [props.open, props.current] as const,
  ([open, current]) => {
    visible.value = open
    if (open) {
      name.value = current
      error.value = ''
    }
  },
  { immediate: true }
)

const limit = computed(() => props.maxlength ?? 60)

function onSubmit(): void {
  const nameError = validateName(name.value, { max: limit.value })
  if (nameError) {
    error.value = nameError
    return
  }
  emit('submit', name.value.trim())
  emit('close')
}

function closeModal(): void {
  emit('close')
}
</script>

<template>
  <ModalShell
    :visible="visible"
    :aria-label="title || '重命名'"
    @close="closeModal"
  >
    <template #header>
      <span class="kr-title">{{ title || '重命名' }}</span>
    </template>

    <div class="kr-body">
      <p v-if="hint" class="kr-hint">{{ hint }}</p>
      <label class="kr-field">
        <span class="kr-label">{{ label || '名称' }}</span>
        <input
          v-model="name"
          class="kr-input"
          :maxlength="limit"
          placeholder="请输入新的名称"
          @keydown.enter.prevent="onSubmit"
        />
      </label>
      <p v-if="error" class="kr-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="kr-btn" type="button" @click="closeModal">取消</button>
      <button class="kr-btn kr-btn--primary" type="button" @click="onSubmit">保存</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.kr-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kr-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 24px;
}

.kr-hint {
  margin: 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--kw-color-text-muted);
}

.kr-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.kr-input {
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

.kr-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kr-error {
  margin: 0;
  font-size: 12px;
  color: #cf625b;
}

.kr-btn {
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

.kr-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.kr-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.kr-btn--primary:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
</style>
