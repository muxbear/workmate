<script setup lang="ts">
import { toastMessage } from '@renderer/composables/useToast'
</script>

<template>
  <Transition name="kw-toast">
    <div v-if="toastMessage" class="kw-toast" role="status" aria-live="polite">
      {{ toastMessage }}
    </div>
  </Transition>
</template>

<style scoped>
/* 全应用唯一的 toast 外观（对齐原设置页胶囊样式；位置取聊天页口径，避免遮住底部输入卡） */
.kw-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  padding: 10px 20px;
  border-radius: 999px;
  background: #2c3337;
  color: #fff;
  font-size: 14px;
  z-index: 9999;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
}

.kw-toast-enter-active,
.kw-toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.kw-toast-enter-from,
.kw-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
</style>
