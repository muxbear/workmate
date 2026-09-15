<script setup lang="ts">
import SettingToggle from '../settings/SettingToggle.vue'

/**
 * 「跟随全局 / 自定义」开关片段（按知识库设置弹窗专用）
 *
 * 语义：following = true 表示该项沿用「知识库设置」页的全局值；打开开关表示该知识库自定义该项。
 * 开关状态与配置值分开表达——值本身仍由父级的 draft 承载。
 */
defineProps<{
  following: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:following': [value: boolean]
}>()

/** 开关语义是「是否自定义」，与 following 相反 */
function onToggle(custom: boolean): void {
  emit('update:following', !custom)
}
</script>

<template>
  <span class="kb-follow">
    <span class="kb-follow-text" :class="{ 'kb-follow-text--custom': !following }">
      {{ following ? '跟随全局' : '自定义' }}
    </span>
    <SettingToggle
      size="sm"
      :model-value="!following"
      :disabled="disabled"
      @update:model-value="onToggle"
    />
  </span>
</template>

<style scoped>
.kb-follow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.kb-follow-text {
  font-size: 12px;
  color: var(--kw-color-text-faint);
  white-space: nowrap;
}

.kb-follow-text--custom {
  color: var(--kw-color-brand);
}
</style>
