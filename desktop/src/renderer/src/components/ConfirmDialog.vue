<script setup lang="ts">
/**
 * 通用确认弹窗：遮罩点击 / 取消按钮 / 确认按钮三种关闭路径
 * 参照 AutomationPage.vue 的 modal 范式；确认按钮使用红色危险风格
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
  <Transition name="modal">
    <div class="confirm-mask" @click.self="emit('cancel')">
      <div class="confirm-card" role="dialog" aria-modal="true">
        <div class="confirm-header">
          <span>{{ title || '提示' }}</span>
          <button class="confirm-close" type="button" aria-label="关闭" @click="emit('cancel')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="confirm-body">
          <p class="confirm-message">{{ message }}</p>
        </div>
        <div class="confirm-footer">
          <button class="confirm-btn confirm-btn--cancel" type="button" @click="emit('cancel')">
            {{ cancelText || '取消' }}
          </button>
          <button class="confirm-btn confirm-btn--danger" type="button" @click="emit('confirm')">
            {{ confirmText || '确认' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
}

.confirm-card {
  width: 380px;
  background: var(--kw-color-surface);
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

.confirm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.confirm-close {
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  padding: 4px;
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

.confirm-footer {
  display: flex;
  gap: 8px;
  padding: 0 24px 20px;
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

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s;
}

.modal-enter-active .confirm-card,
.modal-leave-active .confirm-card {
  transition: transform 0.2s;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .confirm-card,
.modal-leave-to .confirm-card {
  transform: scale(0.92);
}
</style>
