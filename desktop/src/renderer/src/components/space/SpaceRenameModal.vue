<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'

/**
 * 通用重命名弹窗（空间名 / 任务标题共用）。
 *
 * 与知识库的 KnowledgeRenameModal 的差别：本弹窗的提交是异步且可能失败
 * （空间的名称校验/同名守卫/默认空间守卫全在主进程），所以错误与保存态由父级传入，
 * 组件只负责输入、本地非空校验与「保存中」禁用；提交成功后由父级关闭。
 */
const props = defineProps<{
  open: boolean
  /** 弹窗标题 */
  title?: string
  /** 输入框上方的字段名 */
  label?: string
  /** 打开时的名称 */
  current: string
  /** 服务端/业务错误（父级维护） */
  error?: string
  /** 保存中（禁用按钮，防连点） */
  saving?: boolean
  /** 名称长度上限（空间 50；与主进程 NAME_MAX_LEN 一致） */
  maxlength?: number
}>()

const emit = defineEmits<{
  close: []
  submit: [name: string]
}>()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
const name = ref('')
const localError = ref('')

watch(
  () => [props.open, props.current] as const,
  ([open, current]) => {
    visible.value = open
    if (open) {
      name.value = current
      localError.value = ''
    }
  },
  { immediate: true }
)

function onSubmit(): void {
  const next = name.value.trim()
  if (!next) {
    localError.value = '名称不能为空'
    return
  }
  if (props.saving) return
  localError.value = ''
  emit('submit', next)
}

function closeModal(): void {
  if (props.saving) return
  emit('close')
}
</script>

<template>
  <ModalShell :visible="visible" :aria-label="title || '重命名'" @close="closeModal">
    <template #header>
      <span class="sr-title">{{ title || '重命名' }}</span>
    </template>

    <div class="sr-body">
      <label class="sr-field">
        <span class="sr-label">{{ label || '名称' }}</span>
        <input
          v-model="name"
          class="sr-input"
          :maxlength="maxlength ?? 50"
          placeholder="请输入新的名称"
          @keydown.enter.prevent="onSubmit"
        />
      </label>
      <p v-if="localError || error" class="sr-error">{{ localError || error }}</p>
    </div>

    <template #footer>
      <button class="sr-btn" type="button" :disabled="saving" @click="closeModal">取消</button>
      <button
        class="sr-btn sr-btn--primary"
        type="button"
        :disabled="saving || !name.trim()"
        @click="onSubmit"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.sr-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.sr-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 24px;
}

.sr-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.sr-input {
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
  box-sizing: border-box;
}

.sr-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.sr-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kw-color-danger);
}

.sr-btn {
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
    color 0.15s ease,
    opacity 0.15s ease;
}

.sr-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.sr-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sr-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.sr-btn--primary:hover:not(:disabled) {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
</style>
