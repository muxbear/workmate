<script setup lang="ts">
import ModalShell from './ModalShell.vue'

/**
 * 通用确认弹窗：遮罩点击 / 关闭 X / Escape / 取消按钮四种关闭路径（均回 cancel）
 * 确认按钮使用红色危险风格；外壳（遮罩/卡片/头部/过渡）由 ModalShell 统一提供。
 * 由父级以 v-if 控制显隐（保持既有契约）。
 */
defineProps<{
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <ModalShell :visible="true" width="380px" :aria-label="title || '提示'" @close="emit('cancel')">
    <template #header>
      <span class="confirm-title">{{ title || '提示' }}</span>
    </template>
    <div class="confirm-body">
      <p class="confirm-message">{{ message }}</p>
    </div>
    <template #footer>
      <button class="confirm-btn confirm-btn--cancel" type="button" @click="emit('cancel')">
        {{ cancelText || '取消' }}
      </button>
      <button class="confirm-btn confirm-btn--danger" type="button" @click="emit('confirm')">
        {{ confirmText || '确认' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.confirm-body {
  padding: 20px 24px;
}

.confirm-message {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--kw-color-text-secondary);
}

.confirm-btn {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.confirm-btn--cancel {
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-muted);
}

.confirm-btn--danger {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 10px rgba(239, 68, 68, 0.3);
}

.confirm-btn--danger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
