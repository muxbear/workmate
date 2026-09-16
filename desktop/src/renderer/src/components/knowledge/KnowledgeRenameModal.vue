<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
  const trimmed = name.value.trim()
  if (!trimmed) {
    error.value = '名称不能为空'
    return
  }
  if (trimmed.length > limit.value) {
    error.value = `名称不能超过 ${limit.value} 个字符`
    return
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    error.value = '名称不能包含斜杠'
    return
  }
  emit('submit', trimmed)
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
  <Transition name="kr-modal">
    <div v-if="visible" class="kr-mask" @click.self="closeModal">
      <div class="kr-card" role="dialog" aria-modal="true" :aria-label="title || '重命名'">
        <header class="kr-header">
          <span class="kr-title">{{ title || '重命名' }}</span>
          <button class="kr-close" type="button" aria-label="关闭" @click="closeModal">
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

        <footer class="kr-footer">
          <button class="kr-btn" type="button" @click="closeModal">取消</button>
          <button class="kr-btn kr-btn--primary" type="button" @click="onSubmit">保存</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.kr-mask {
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

.kr-card {
  width: min(440px, calc(100vw - 48px));
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.kr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.kr-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kr-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.kr-close:hover {
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

.kr-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
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

.kr-modal-enter-active,
.kr-modal-leave-active {
  transition: opacity 0.2s;
}

.kr-modal-enter-active .kr-card,
.kr-modal-leave-active .kr-card {
  transition: transform 0.2s;
}

.kr-modal-enter-from,
.kr-modal-leave-to {
  opacity: 0;
}

.kr-modal-enter-from .kr-card,
.kr-modal-leave-to .kr-card {
  transform: scale(0.92);
}
</style>
