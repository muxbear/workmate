<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModelStore } from '@store/models'
import { createHoverMenu } from '@renderer/composables/hoverMenu'

/**
 * 模型选择下拉（R6：自 PromptInput 模板外提）。
 *
 * - 内置模型（Auto）与自定义模型（modelStore.models）分组展示；
 * - hover 开合：按钮移入打开、移出延迟关闭（给鼠标移入菜单留时间）；
 * - 自定义模型名可重复、id 唯一，选中态回传 `customModelId`（内置模型为 null）。
 */
const model = defineModel<string>({ required: true })
/** 当前选中的自定义模型 id（内置模型为 null） */
const customModelId = defineModel<string | null>('customModelId', { default: null })

const props = withDefaults(
  defineProps<{
    /** 紧凑样式（对话态输入框） */
    compact?: boolean
    /** 下拉展开方向（弹窗内空间不足时向下展开） */
    menuPlacement?: 'up' | 'down'
  }>(),
  { compact: false, menuPlacement: 'up' }
)

const modelStore = useModelStore()
const modelOpen = ref(false)
const modelMenuHover = createHoverMenu(modelOpen)

/** 内置模型（仅 Auto 走默认 agent 配置；其余模型经 modelStore 追加展示） */
const BUILTIN_MODELS = ['Auto']

/** 模型下拉分组：内置 + 自定义（自定义模型名可重复，id 唯一，故按 id 传参） */
const modelGroups = computed(() => [
  {
    name: '内置模型',
    items: BUILTIN_MODELS.map((name) => ({ name, id: undefined as string | undefined }))
  },
  { name: '自定义模型', items: modelStore.models.map((m) => ({ name: m.name, id: m.id })) }
])

const selectModel = (opt: { name: string; id?: string }): void => {
  model.value = opt.name
  customModelId.value = opt.id ?? null
  modelOpen.value = false
}

/** 关闭下拉（父级发送时调用，对齐历史「onSend 关闭模型下拉」行为） */
function close(): void {
  modelMenuHover.closeNow()
}

defineExpose({ close })
</script>

<template>
  <div :class="['model-selector', { 'model-selector--compact': props.compact }]">
    <button
      class="model-btn"
      @mouseenter="modelMenuHover.open"
      @mouseleave="modelMenuHover.scheduleClose"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      {{ model }}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    <Transition name="dropdown">
      <div
        v-if="modelOpen"
        :class="['model-dropdown', { 'model-dropdown--down': props.menuPlacement === 'down' }]"
        @mouseenter="modelMenuHover.cancelClose"
        @mouseleave="modelMenuHover.closeNow"
      >
        <template v-for="group in modelGroups" :key="group.name">
          <div v-if="group.items.length > 0" class="model-group-label">
            {{ group.name }}
          </div>
          <button
            v-for="opt in group.items"
            :key="opt.id ?? opt.name"
            :class="['model-option', { 'model-option--active': model === opt.name }]"
            @click="selectModel(opt)"
          >
            <svg
              v-if="model === opt.name"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span v-else class="model-option-gap"></span>
            {{ opt.name }}
          </button>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
}

.model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.model-btn:hover {
  background: var(--kw-color-brand-soft);
}

.model-btn svg:first-child {
  color: var(--kw-color-brand);
}

.model-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 20;
}

.model-group-label {
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 600;
  color: var(--kw-color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.1s ease;
}

.model-option:hover {
  background: var(--kw-color-brand-hover);
}

.model-option--active {
  color: var(--kw-color-brand);
  font-weight: 600;
}

.model-option-gap {
  width: 10px;
}

/* 弹窗内空间不足时向下展开 */
.model-dropdown--down {
  top: calc(100% + 4px);
  bottom: auto;
}

.model-selector--compact .model-btn {
  padding: 2px 8px;
  font-size: 11px;
}

/* 下拉过渡（与 PlusMenu / 设置页同名动效一致；scoped 即作用于本组件模板） */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
