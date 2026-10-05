<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import ModalShell from './ModalShell.vue'

/**
 * 权限菜单（R6：自 PromptInput 模板外提）。
 *
 * 「默认权限」触发器 + 上滑弹层（允许完全访问开关）+ 开启前的风险确认弹窗。
 * v-model 只承载布尔开关；**持久化（localStorage）与消息载荷（fullAccess 字段）由父级负责**。
 */
const fullAccess = defineModel<boolean>({ required: true })

const menuOpen = ref(false)
const showConfirm = ref(false)
const riskChecked = ref(false)

/** 点击外部关闭（与 PromptInput 的全局菜单关闭同口径：触发器 / 弹层均白名单） */
const handleDocumentClick = (e: MouseEvent): void => {
  const target = e.target as HTMLElement
  if (!target.closest('[data-perm-menu-trigger]') && !target.closest('.perm-menu')) {
    menuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentClick)
})

/** 点击开关：关闭到开启需经风险确认弹窗；开启到关闭直接切换 */
const onSwitchClick = (): void => {
  if (fullAccess.value) {
    fullAccess.value = false
  } else {
    riskChecked.value = false
    showConfirm.value = true
  }
}

const confirmFullAccess = (): void => {
  fullAccess.value = true
  showConfirm.value = false
}

const cancelFullAccess = (): void => {
  showConfirm.value = false
}
</script>

<template>
  <div class="perm-selector">
    <button
      class="footer-action"
      data-perm-menu-trigger
      @click="menuOpen = !menuOpen"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      默认权限
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    <Transition name="plus-menu-slide">
      <div v-if="menuOpen" class="perm-menu" @click.stop>
        <p class="perm-desc">
          当前为默认权限，所有操作都会在安全沙箱约束内进行，超出范围会请求你的允许。
        </p>
        <div class="perm-row">
          <span class="perm-row-label">允许完全访问</span>
          <button
            class="perm-switch"
            :class="{ 'perm-switch--on': fullAccess }"
            type="button"
            role="switch"
            :aria-checked="fullAccess"
            title="开启后将减少确认步骤，允许 AI 直接执行更多操作。可能涉及敏感操作、文件修改或外部执行"
            @click="onSwitchClick"
          >
            <span class="perm-switch-knob"></span>
          </button>
        </div>
      </div>
    </Transition>
  </div>

  <!-- 允许完全访问风险确认 -->
  <ModalShell
    :visible="showConfirm"
    width="420px"
    :z-index="200"
    aria-label="开启允许完全访问"
    @close="cancelFullAccess"
  >
    <template #header>
      <span>开启允许完全访问</span>
    </template>

    <div class="perm-confirm-body">
      <p class="perm-confirm-message">
        开启允许完全访问后，AI
        将减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部执行。仅建议在您信任当前任务时使用。
      </p>
      <label class="perm-risk">
        <input v-model="riskChecked" type="checkbox" class="perm-risk-checkbox" />
        <span>我已了解风险，并愿意继续</span>
      </label>
    </div>

    <template #footer>
      <button
        class="perm-confirm-btn perm-confirm-btn--cancel"
        type="button"
        @click="cancelFullAccess"
      >
        取消
      </button>
      <button
        class="perm-confirm-btn perm-confirm-btn--confirm"
        type="button"
        :disabled="!riskChecked"
        @click="confirmFullAccess"
      >
        允许完全访问
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.perm-selector {
  position: relative;
}

.perm-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 300px;
  padding: 12px 14px;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border);
  border-radius: 10px;
  box-shadow:
    0 -2px 16px rgba(0, 0, 0, 0.1),
    0 4px 20px rgba(0, 0, 0, 0.08);
  z-index: 100;
}

.perm-desc {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--kw-color-text-muted);
}

.perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.perm-row-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text);
}

/* 开关（与 PlusMenu 模式开关同视觉） */
.perm-switch {
  position: relative;
  width: 30px;
  height: 17px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: #e2e8f0;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.perm-switch--on {
  background: var(--kw-gradient-brand);
}

.perm-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--kw-color-surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.15s ease;
}

.perm-switch--on .perm-switch-knob {
  transform: translateX(13px);
}

/* 风险确认弹窗 */
.perm-confirm-body {
  padding: 0 20px 12px;
}

.perm-confirm-message {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--kw-color-text-secondary);
}

.perm-risk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--kw-color-bg-soft);
  border: 1px solid var(--kw-color-border);
  cursor: pointer;
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.perm-risk-checkbox {
  accent-color: var(--kw-color-brand);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.perm-confirm-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease;
}

.perm-confirm-btn--cancel {
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
}

.perm-confirm-btn--cancel:hover {
  background: #e5e7eb;
}

.perm-confirm-btn--confirm {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
}

.perm-confirm-btn--confirm:hover {
  opacity: 0.9;
}

.perm-confirm-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
