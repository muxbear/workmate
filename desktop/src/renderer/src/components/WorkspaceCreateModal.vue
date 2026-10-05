<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from './ModalShell.vue'
import { useWorkspaceStore } from '@store/workspace'

/**
 * 新建工作空间弹窗（R6：自 PromptInput 模板外提）。
 *
 * 确认创建走 workspaceStore（主进程 sanitize 是权威校验，错误经 createError 展示）；
 * 打开时重置输入与错误（对齐原「openCreateModal 先清空再显示」的行为）。
 */
const visible = defineModel<boolean>({ required: true })

const workspaceStore = useWorkspaceStore()

const createName = ref('')
const createError = ref('')
const creating = ref(false)

watch(visible, (v) => {
  if (v) {
    createName.value = ''
    createError.value = ''
  }
})

/** 确认创建：主进程 sanitize 是权威校验，错误经 createError 展示 */
const confirmCreate = async (): Promise<void> => {
  const name = createName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    await workspaceStore.create(name)
    visible.value = false
    createName.value = ''
  } catch (err) {
    createError.value = err instanceof Error ? err.message : '新建工作空间失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <ModalShell
    :visible="visible"
    width="360px"
    :z-index="200"
    aria-label="新建工作空间"
    @close="visible = false"
  >
    <template #header>
      <span>新建工作空间</span>
    </template>

    <div class="ws-modal-body">
      <label class="ws-modal-label" for="prompt-ws-create-name">工作空间名称</label>
      <input
        id="prompt-ws-create-name"
        v-model="createName"
        class="ws-modal-input"
        maxlength="50"
        placeholder="将创建于 ~/KeWork/ 目录下"
        @keydown.enter.prevent="confirmCreate"
      />
      <p v-if="createError" class="ws-modal-error">{{ createError }}</p>
      <p class="ws-modal-hint">将在系统家目录的 KeWork/ 下创建同名文件夹</p>
    </div>

    <template #footer>
      <button class="ws-modal-btn ws-modal-btn--cancel" @click="visible = false">取消</button>
      <button
        class="ws-modal-btn ws-modal-btn--confirm"
        :disabled="creating || !createName.trim()"
        @click="confirmCreate"
      >
        创建
      </button>
    </template>
  </ModalShell>
</template>

<style scoped>
.ws-modal-body {
  padding: 0 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-modal-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ws-modal-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #d1d9e6;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.ws-modal-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px rgba(8, 145, 178, 0.12);
}

.ws-modal-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kw-color-danger);
}

.ws-modal-hint {
  margin: 0;
  font-size: 11px;
  color: var(--kw-color-text-subtle);
}

.ws-modal-btn {
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

.ws-modal-btn--cancel {
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
}

.ws-modal-btn--cancel:hover {
  background: #e5e7eb;
}

.ws-modal-btn--confirm {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
}

.ws-modal-btn--confirm:hover {
  opacity: 0.9;
}

.ws-modal-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
