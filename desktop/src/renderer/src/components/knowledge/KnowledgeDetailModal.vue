<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 通用详情弹窗：只渲染父级传进来的只读信息行（文件 / 文件夹 / 知识库共用）
 */
const props = defineProps<{
  open: boolean
  title: string
  subtitle?: string
  items: Array<{ label: string; value: string }>
}>()

const emit = defineEmits<{
  close: []
}>()

/** 窗口可见性：由父组件 open prop 驱动，保证关闭时有退出动画 */
const visible = ref(props.open)

watch(
  () => props.open,
  (open) => {
    visible.value = open
  },
  { immediate: true }
)

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
  <Transition name="kdt-modal">
    <div v-if="visible" class="kdt-mask" @click.self="closeModal">
      <div class="kdt-card" role="dialog" aria-modal="true" :aria-label="title">
        <header class="kdt-header">
          <div class="kdt-heading">
            <h2 class="kdt-title">{{ title }}</h2>
            <p v-if="subtitle" class="kdt-subtitle">{{ subtitle }}</p>
          </div>
          <button class="kdt-close" type="button" aria-label="关闭" @click="closeModal">
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

        <div class="kdt-body">
          <div v-for="item in items" :key="item.label" class="kdt-row">
            <span class="kdt-label">{{ item.label }}</span>
            <span class="kdt-value">{{ item.value }}</span>
          </div>
        </div>

        <footer class="kdt-footer">
          <button class="kdt-btn" type="button" @click="closeModal">关闭</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.kdt-mask {
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

.kdt-card {
  width: min(460px, calc(100vw - 48px));
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.kdt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.kdt-heading {
  min-width: 0;
}

.kdt-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  word-break: break-all;
}

.kdt-subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.kdt-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.kdt-close:hover {
  color: var(--kw-color-text);
}

.kdt-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 24px;
}

.kdt-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  font-size: 13px;
  line-height: 20px;
}

.kdt-label {
  width: 72px;
  flex-shrink: 0;
  color: var(--kw-color-text-muted);
}

.kdt-value {
  min-width: 0;
  flex: 1;
  color: var(--kw-color-text-secondary);
  word-break: break-all;
}

.kdt-footer {
  display: flex;
  padding: 0 24px 20px;
}

.kdt-btn {
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  border: none;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.kdt-btn:hover {
  opacity: 0.92;
}

.kdt-modal-enter-active,
.kdt-modal-leave-active {
  transition: opacity 0.2s;
}

.kdt-modal-enter-active .kdt-card,
.kdt-modal-leave-active .kdt-card {
  transition: transform 0.2s;
}

.kdt-modal-enter-from,
.kdt-modal-leave-to {
  opacity: 0;
}

.kdt-modal-enter-from .kdt-card,
.kdt-modal-leave-to .kdt-card {
  transform: scale(0.92);
}
</style>
