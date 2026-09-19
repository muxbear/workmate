<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Zap } from 'lucide-vue-next'
import { fetchProviders } from '@/services/modelApi'
import { useChatStore } from '@/stores/chat'

const chatStore = useChatStore()
const open = ref(false)
const options = ref<{ name: string; providerId: string; modelId: string }[]>([])

const current = computed(() => chatStore.selection.model ?? '默认模型')

async function loadModels() {
  if (options.value.length > 0) return
  try {
    const providers = await fetchProviders()
    const list: { name: string; providerId: string; modelId: string }[] = []
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        if (model.type !== 'llm' && model.type !== 'multimodal') continue
        if (model.status === 'inactive' || model.status === 'deprecated') continue
        list.push({
          name: model.displayName || model.name,
          providerId: provider.id,
          modelId: model.id,
        })
      }
    }
    options.value = list
  } catch {
    options.value = []
  }
}

function pick(option: { name: string; providerId: string; modelId: string }) {
  chatStore.setModel(option.name, option.providerId, option.modelId)
  open.value = false
}

function pickDefault() {
  chatStore.setModel(null, null, null)
  open.value = false
}

function toggle() {
  open.value = !open.value
  if (open.value) void loadModels()
}

onMounted(() => {
  void loadModels()
})
</script>

<template>
  <div class="model-selector">
    <button class="model-btn" title="选择模型" @click="toggle">
      <Zap :size="12" />
      <span class="model-current">{{ current }}</span>
    </button>
    <div v-if="open" class="model-dropdown">
      <button
        class="model-option"
        :class="{ active: !chatStore.selection.model }"
        @click="pickDefault"
      >
        <Check v-if="!chatStore.selection.model" :size="12" />
        <span>默认模型</span>
      </button>
      <button
        v-for="option in options"
        :key="option.providerId + option.name"
        class="model-option"
        :class="{ active: chatStore.selection.model === option.name }"
        @click="pick(option)"
      >
        <Check v-if="chatStore.selection.model === option.name" :size="12" />
        <span class="model-name">{{ option.name }}</span>
      </button>
      <p v-if="options.length === 0" class="model-empty">暂无可用模型</p>
    </div>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  display: flex;
  align-items: center;
}

.model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.model-btn:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.model-current {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  z-index: 200;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.model-option:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.model-option.active {
  color: var(--accent-primary);
}

.model-option svg {
  flex-shrink: 0;
  width: 12px;
}

.model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-empty {
  margin: 0;
  padding: 8px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}
</style>
