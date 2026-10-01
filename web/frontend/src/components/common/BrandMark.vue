<script setup lang="ts">
import { computed, useId } from 'vue'

/**
 * 品牌标识：有自定义 LOGO 时渲染图片，否则回退到内置 SVG。
 *
 * 内置图形沿用登录页原有的蓝紫同心圆，**不是**桌面版那套青色图形——
 * 换掉等于顺手把全站换皮，不在本次范围内。
 *
 * `size` 不传时撑满父容器（登录页的品牌框有自己的尺寸变量）。
 */
const props = withDefaults(defineProps<{ size?: number; src?: string | null }>(), {
  size: undefined,
  src: null,
})

const box = computed(() =>
  props.size
    ? { width: `${props.size}px`, height: `${props.size}px` }
    : { width: '100%', height: '100%' },
)

// 同页可能有多个实例，gradient id 必须唯一，否则后一个会抢占前一个的填充
const gradientId = 'brand-logo-' + useId()
</script>

<template>
  <img
    v-if="props.src"
    class="brand-mark"
    :style="box"
    :src="props.src"
    alt="系统 LOGO"
    draggable="false"
  />
  <svg
    v-else
    class="brand-mark"
    :style="box"
    viewBox="0 0 96 96"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect width="96" height="96" rx="20" :fill="`url(#${gradientId})`" />
    <circle cx="48" cy="48" r="28" stroke="white" stroke-width="3" fill="none" opacity="0.9" />
    <circle cx="48" cy="48" r="14" stroke="white" stroke-width="2" fill="none" opacity="0.6" />
    <circle cx="48" cy="28" r="4" fill="white" opacity="0.8" />
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="96" y2="96">
        <stop offset="0%" stop-color="#3b82f6" />
        <stop offset="100%" stop-color="#8b5cf6" />
      </linearGradient>
    </defs>
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex-shrink: 0;
  object-fit: contain;
}
</style>
