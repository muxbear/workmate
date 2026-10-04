<script setup lang="ts">
import { ref, watch } from 'vue'
import ModalShell from '../ModalShell.vue'

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
</script>

<template>
  <ModalShell :visible="visible" width="min(460px, calc(100vw - 48px))" :aria-label="title" @close="closeModal">
    <template #header>
      <div class="kdt-heading">
        <h2 class="kdt-title">{{ title }}</h2>
        <p v-if="subtitle" class="kdt-subtitle">{{ subtitle }}</p>
      </div>
    </template>

    <div class="kdt-body">
      <div v-for="item in items" :key="item.label" class="kdt-row">
        <span class="kdt-label">{{ item.label }}</span>
        <span class="kdt-value">{{ item.value }}</span>
      </div>
    </div>

    <template #footer>
      <button class="kdt-btn" type="button" @click="closeModal">关闭</button>
    </template>
  </ModalShell>
</template>

<style scoped>
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

</style>
