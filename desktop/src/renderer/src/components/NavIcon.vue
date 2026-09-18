<script setup lang="ts">
import type { NavIconName } from './navIcon'

/**
 * 侧栏一级菜单图标。
 *
 * 收起侧栏只展示图标，图形须与展开态完全一致；
 * 两处共用本组件，避免同一图标出现多份拷贝后逐渐走样。
 */
withDefaults(
  defineProps<{
    /** 图标标识（与 navItems 的 icon 字段对应） */
    name: NavIconName
    /** 图标边长（px），默认与展开态侧栏一致 */
    size?: number
  }>(),
  { size: 15 }
)
</script>

<template>
  <!-- 新建任务 -->
  <svg
    v-if="name === 'plus'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>

  <!-- 助理 -->
  <svg
    v-else-if="name === 'bot'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <rect x="3" y="3" width="18" height="14" rx="3" />
    <path d="M8 21h8M12 17v4" />
  </svg>

  <!-- 项目 -->
  <svg
    v-else-if="name === 'folder'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>

  <!-- 知识库 -->
  <svg
    v-else-if="name === 'book'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 7v14" />
    <path
      d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
    />
  </svg>

  <!-- 自动化 -->
  <svg
    v-else-if="name === 'workflow'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <rect x="2" y="3" width="6" height="6" rx="1" />
    <rect x="9" y="2" width="6" height="8" rx="1" />
    <rect x="16" y="3" width="6" height="6" rx="1" />
    <path d="M5 9v4a2 2 0 0 0 2 2h3M12 6v2M19 9v4a2 2 0 0 1-2 2h-2" />
  </svg>

  <!-- 智能体（可折叠分组） -->
  <svg
    v-else-if="name === 'agent'"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <line x1="9" y1="1" x2="9" y2="4" />
    <line x1="15" y1="1" x2="15" y2="4" />
    <line x1="9" y1="20" x2="9" y2="23" />
    <line x1="15" y1="20" x2="15" y2="23" />
    <line x1="20" y1="9" x2="23" y2="9" />
    <line x1="20" y1="14" x2="23" y2="14" />
    <line x1="1" y1="9" x2="4" y2="9" />
    <line x1="1" y1="14" x2="4" y2="14" />
  </svg>

  <!-- 更多 -->
  <svg
    v-else
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
</template>
