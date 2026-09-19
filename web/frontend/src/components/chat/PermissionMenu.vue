<script setup lang="ts">
import { computed, ref } from 'vue'
import { ShieldCheck } from 'lucide-vue-next'
import { useChatStore } from '@/stores/chat'

/** 权限菜单：默认权限 / 联网访问 / 代码执行（对齐桌面版「允许完全访问」的等价改造）。 */
const chatStore = useChatStore()

const open = ref(false)
const pendingKey = ref<'allowNetwork' | 'allowShell' | null>(null)
const riskChecked = ref(false)

const label = computed(() => {
  const { allowNetwork, allowShell } = chatStore.selection
  if (allowNetwork && allowShell) return '联网 + 代码执行'
  if (allowNetwork) return '联网访问'
  if (allowShell) return '代码执行'
  return '默认权限'
})

function isOn(key: 'allowNetwork' | 'allowShell'): boolean {
  return key === 'allowNetwork' ? chatStore.selection.allowNetwork : chatStore.selection.allowShell
}

function toggle(key: 'allowNetwork' | 'allowShell') {
  if (isOn(key)) {
    chatStore.setSelection(key === 'allowNetwork' ? { allowNetwork: false } : { allowShell: false })
    return
  }
  pendingKey.value = key
  riskChecked.value = false
}

function confirm() {
  if (!pendingKey.value || !riskChecked.value) return
  chatStore.setSelection(
    pendingKey.value === 'allowNetwork' ? { allowNetwork: true } : { allowShell: true },
  )
  pendingKey.value = null
  open.value = false
}

function cancel() {
  pendingKey.value = null
  riskChecked.value = false
}
</script>

<template>
  <div class="perm-selector">
    <button
      class="footer-action"
      :class="{ 'footer-action--active': isOn('allowNetwork') || isOn('allowShell') }"
      @click="open = !open"
    >
      <ShieldCheck :size="11" />
      {{ label }}
    </button>
    <div v-if="open" class="perm-menu">
      <p class="perm-desc">
        默认权限下仅可读写会话工作区；开启联网访问或代码执行后，智能体可访问外部资源或运行命令，请谨慎使用。
      </p>
      <div class="perm-row">
        <span class="perm-row-label">联网访问</span>
        <button
          class="perm-switch"
          :class="{ 'perm-switch--on': isOn('allowNetwork') }"
          @click="toggle('allowNetwork')"
        >
          <span class="perm-switch-knob" />
        </button>
      </div>
      <div class="perm-row">
        <span class="perm-row-label">代码执行</span>
        <button
          class="perm-switch"
          :class="{ 'perm-switch--on': isOn('allowShell') }"
          @click="toggle('allowShell')"
        >
          <span class="perm-switch-knob" />
        </button>
      </div>
    </div>

    <div v-if="pendingKey" class="perm-mask" @click.self="cancel">
      <div class="perm-confirm">
        <p class="perm-confirm-title">开启高风险权限</p>
        <p class="perm-confirm-text">
          {{
            pendingKey === 'allowNetwork'
              ? '允许智能体访问外部网络资源'
              : '允许智能体执行命令与代码'
          }}，可能带来数据外泄或环境变更风险。
        </p>
        <label class="perm-risk">
          <input v-model="riskChecked" type="checkbox" />
          <span>我已了解风险，并确认开启</span>
        </label>
        <div class="perm-confirm-actions">
          <button class="perm-btn perm-btn--cancel" @click="cancel">取消</button>
          <button class="perm-btn perm-btn--confirm" :disabled="!riskChecked" @click="confirm">
            确认开启
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perm-selector {
  position: relative;
  display: flex;
  align-items: center;
}

.footer-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.footer-action:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.footer-action--active {
  color: var(--accent-primary);
}

.perm-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 280px;
  padding: 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  z-index: 210;
}

.perm-desc {
  margin: 0 0 10px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.perm-row-label {
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
}

.perm-switch {
  position: relative;
  width: 30px;
  height: 17px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--border-medium);
  cursor: pointer;
  transition: background 0.15s ease;
}

.perm-switch--on {
  background: var(--accent-primary);
}

.perm-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: var(--radius-full);
  background: #fff;
  transition: transform 0.15s ease;
}

.perm-switch--on .perm-switch-knob {
  transform: translateX(13px);
}

.perm-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.4);
  z-index: 300;
}

.perm-confirm {
  width: 400px;
  padding: 18px 20px 16px;
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
}

.perm-confirm-title {
  margin: 0 0 8px;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.perm-confirm-text {
  margin: 0 0 12px;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.7;
}

.perm-risk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.perm-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.perm-btn {
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.perm-btn--cancel {
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.perm-btn--confirm {
  background: var(--accent-primary);
  color: #fff;
}

.perm-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
