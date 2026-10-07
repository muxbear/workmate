<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from '@components/ModalShell.vue'

/**
 * 昵称编辑弹窗（账户管理页）。
 *
 * 与 SpaceRenameModal 的差别：允许留空提交（= 清除昵称，显示名回退登录账号），
 * 所以没有「不能为空」本地校验，保存按钮也不因空输入禁用；
 * 长度等校验在主进程（权威），错误与保存态由父级传入，提交成功后由父级关闭。
 */
const props = defineProps<{
  open: boolean
  /** 打开时的昵称（未设置为空串） */
  current: string
  /** 服务端/业务错误（父级维护） */
  error?: string
  /** 保存中（禁用按钮，防连点） */
  saving?: boolean
  /** 昵称长度上限（与主进程 NICKNAME_MAX_LEN 一致） */
  maxlength?: number
}>()

const emit = defineEmits<{
  close: []
  submit: [nickname: string]
}>()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)
const name = ref('')

watch(
  () => [props.open, props.current] as const,
  ([open, current]) => {
    visible.value = open
    if (open) name.value = current
  },
  { immediate: true }
)

function onSubmit(): void {
  if (props.saving) return
  emit('submit', name.value.trim())
}

function closeModal(): void {
  if (props.saving) return
  emit('close')
}
</script>

<template>
  <ModalShell :visible="visible" aria-label="修改昵称" @close="closeModal">
    <template #header>
      <span class="ne-title">修改昵称</span>
    </template>

    <div class="ne-body">
      <label class="ne-field">
        <span class="ne-label">昵称</span>
        <input
          v-model="name"
          class="ne-input"
          :maxlength="maxlength ?? 20"
          placeholder="请输入昵称，留空则清除"
          aria-label="昵称"
          @keydown.enter.prevent="onSubmit"
        />
      </label>
      <p v-if="error" class="ne-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="ne-btn" type="button" :disabled="saving" @click="closeModal">取消</button>
      <button class="ne-btn ne-btn--primary" type="button" :disabled="saving" @click="onSubmit">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.ne-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ne-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 24px;
}

.ne-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ne-input {
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

.ne-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.ne-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kw-color-danger);
}

.ne-btn {
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

.ne-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.ne-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ne-btn--primary {
  border-color: transparent;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.ne-btn--primary:hover:not(:disabled) {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  opacity: 0.92;
}
</style>
