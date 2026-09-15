<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

const NAME_MAX = 60
const DESC_MAX = 120

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
  const trimmedName = name.value.trim()
  if (!trimmedName) {
    error.value = '知识库名称不能为空'
    return
  }
  if (trimmedName.length > NAME_MAX) {
    error.value = `名称不能超过 ${NAME_MAX} 个字符`
    return
  }
  const trimmedDesc = description.value.trim()
  if (trimmedDesc.length > DESC_MAX) {
    error.value = `描述不能超过 ${DESC_MAX} 个字符`
    return
  }
  emit('saved', trimmedName, trimmedDesc)
  emit('close')
}

function closeModal(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) closeModal()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Transition name="ke-modal">
    <div v-if="visible" class="ke-mask" @click.self="closeModal">
      <div class="ke-card" role="dialog" aria-modal="true" aria-label="编辑知识库">
        <header class="ke-header">
          <span class="ke-title">知识库编辑</span>
          <button class="ke-close" type="button" aria-label="关闭" @click="closeModal">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div class="ke-body">
          <label class="ke-field">
            <span class="ke-label">名称</span>
            <input
              v-model="name"
              class="ke-input"
              :maxlength="NAME_MAX"
              placeholder="请输入知识库名称"
            />
          </label>
          <label class="ke-field">
            <span class="ke-label">描述</span>
            <textarea
              v-model="description"
              class="ke-input ke-textarea"
              :maxlength="DESC_MAX"
              rows="3"
              placeholder="简单说明这个知识库的用途"
            />
          </label>
          <p v-if="error" class="ke-error">
            {{ error }}
          </p>
        </div>

        <footer class="ke-footer">
          <button class="ke-btn" type="button" @click="closeModal">取消</button>
          <button class="ke-btn ke-btn--primary" type="button" @click="onSave">保存</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ke-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.ke-card {
  width: min(440px, calc(100vw - 48px));
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.ke-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ke-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ke-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.ke-close:hover {
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

.ke-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
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

.ke-modal-enter-active,
.ke-modal-leave-active {
  transition: opacity 0.2s;
}

.ke-modal-enter-active .ke-card,
.ke-modal-leave-active .ke-card {
  transition: transform 0.2s;
}

.ke-modal-enter-from,
.ke-modal-leave-to {
  opacity: 0;
}

.ke-modal-enter-from .ke-card,
.ke-modal-leave-to .ke-card {
  transform: scale(0.92);
}
</style>
