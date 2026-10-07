<script setup lang="ts">
import ModalShell from './ModalShell.vue'

/**
 * 主窗口关闭确认弹窗（首次点窗口关闭按钮时，主进程推送 app:close-confirm-request 触发）
 *
 * 由 App.vue 全局挂载（登录页点 ✕ 同样覆盖），**父级以 v-if 控制显隐**（同 ConfirmDialog 契约）：
 * 选择「最小化到托盘」后窗口立即隐藏，Chromium 会暂停隐藏窗口的渲染（含 rAF），
 * 依赖离场过渡（双 rAF 启动）的 v-if 切换会滞留 DOM —— 父级整体卸载则同步移除，不依赖渲染。
 * z-index 2000：需压过设置浮层（50/60）、下拉菜单（100/101）、重命名遮罩（200）与滑块验证（1000），
 * 同时低于 ToastHost（9999）。遮罩 / Esc / 头部 ✕ 均按「取消」处理（本次不关、不保存，下次再询问）。
 */

const emit = defineEmits<{
  choose: [choice: 'tray' | 'close']
  cancel: []
}>()
</script>

<template>
  <ModalShell
    :visible="true"
    width="420px"
    :z-index="2000"
    aria-label="关闭窗口"
    @close="emit('cancel')"
  >
    <template #header>
      <span class="close-confirm-title">关闭窗口</span>
    </template>
    <div class="close-confirm-body">
      <p class="close-confirm-message">点击关闭按钮时，您希望：</p>
      <p class="close-confirm-hint">
        「最小化到托盘」会隐藏窗口，在任务栏右下角显示图标（右键可退出应用）。
        选择后将记住，之后不再询问；可在「系统设置 → 关闭行为」中修改。
      </p>
    </div>
    <template #footer>
      <button
        class="close-confirm-btn close-confirm-btn--cancel"
        type="button"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        class="close-confirm-btn close-confirm-btn--close"
        type="button"
        @click="emit('choose', 'close')"
      >
        直接关闭窗口
      </button>
      <button
        class="close-confirm-btn close-confirm-btn--tray"
        type="button"
        @click="emit('choose', 'tray')"
      >
        最小化到托盘
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.close-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.close-confirm-body {
  padding: 20px 24px;
}

.close-confirm-message {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--kw-color-text-secondary);
}

.close-confirm-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--kw-color-text-faint);
}

.close-confirm-btn {
  padding: 10px 14px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.close-confirm-btn--cancel {
  margin-right: auto;
  background: var(--kw-color-bg-tint);
  color: var(--kw-color-text-muted);
}

.close-confirm-btn--close {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 10px rgba(239, 68, 68, 0.3);
}

.close-confirm-btn--tray {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.12);
}

.close-confirm-btn:hover {
  opacity: 0.92;
}
</style>
