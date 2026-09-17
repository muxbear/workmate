<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 新建知识库弹窗（名称 + 描述）
 *
 * 只负责收集与本地校验，落盘交给父级（store → 主进程）；
 * 名称/描述上限与主进程 KnowledgeService 保持一致。
 */
const props = defineProps<{
  open: boolean
  /** 目标分组：local / shared / cloud */
  kind?: 'local' | 'shared' | 'cloud'
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { name: string; description: string }]
}>()

const NAME_MAX = 60
const DESC_MAX = 120

const KIND_LABEL: Record<string, string> = {
  local: '本地知识库',
  shared: '我的共享知识',
  cloud: '云端知识库'
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
  emit('submit', { name: trimmedName, description: trimmedDesc })
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
  <Transition name="kc-modal">
    <div v-if="visible" class="kc-mask" @click.self="closeModal">
      <div class="kc-card" role="dialog" aria-modal="true" aria-label="新建知识库">
        <header class="kc-header">
          <div>
            <span class="kc-title">新建知识库</span>
            <p class="kc-subtitle">将创建到「{{ KIND_LABEL[kind ?? 'local'] }}」</p>
          </div>
          <button class="kc-close" type="button" aria-label="关闭" @click="closeModal">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div class="kc-body">
          <label class="kc-field">
            <span class="kc-label">名称</span>
            <input
              v-model="name"
              class="kc-input"
              :maxlength="NAME_MAX"
              placeholder="例如：产品资料库"
              @keydown.enter.prevent="onSubmit"
            />
          </label>
          <label class="kc-field">
            <span class="kc-label">描述（可选）</span>
            <textarea
              v-model="description"
              class="kc-input kc-textarea"
              :maxlength="DESC_MAX"
              rows="3"
              placeholder="简单说明这个知识库的用途"
            />
          </label>
          <p v-if="error" class="kc-error">{{ error }}</p>
        </div>

        <footer class="kc-footer">
          <button class="kc-btn" type="button" @click="closeModal">取消</button>
          <button class="kc-btn kc-btn--primary" type="button" @click="onSubmit">创建</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.kc-mask {
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

.kc-card {
  width: min(440px, calc(100vw - 48px));
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.kc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

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

.kc-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.kc-close:hover {
  color: var(--kw-color-text);
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

.kc-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
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

.kc-modal-enter-active,
.kc-modal-leave-active {
  transition: opacity 0.2s;
}

.kc-modal-enter-active .kc-card,
.kc-modal-leave-active .kc-card {
  transition: transform 0.2s;
}

.kc-modal-enter-from,
.kc-modal-leave-to {
  opacity: 0;
}

.kc-modal-enter-from .kc-card,
.kc-modal-leave-to .kc-card {
  transform: scale(0.92);
}
</style>
