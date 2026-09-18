<script setup lang="ts">
import { computed, useId } from 'vue'
import { useSettingsStore } from '../../store/settings'

/**
 * 系统 LOGO（「系统设置 → 系统标识」）
 *
 * - 已自定义：渲染上传的图片（data URL，主进程按魔数校验后落盘到 ~/.ke-work/branding）
 * - 未自定义：渲染内置兜底 LOGO —— variant=full 为登录页完整版，mark 为侧栏/设置/头像简化版
 * - 尺寸由 size 设定（px），需要跟随父级样式时可传 size=0 并用外层 class 覆盖
 */
const props = withDefaults(
  defineProps<{
    /** 展示尺寸（px） */
    size?: number
    /** 兜底 LOGO 形态：full = 完整版，mark = 简化标记 */
    variant?: 'full' | 'mark'
  }>(),
  { size: 28, variant: 'mark' }
)

const settingsStore = useSettingsStore()

// 渐变 id 逐实例唯一：同页多实例（侧栏 + 设置窗口 + 头像）时不互相抢占
const uid = useId()
const markGradientId = 'brand-mark-' + uid
const fullGradientId = 'brand-full-' + uid
const fullAccentId = 'brand-full-accent-' + uid

/** 自定义 LOGO 地址（空 = 走内置兜底） */
const logoUrl = computed(() => settingsStore.brandLogoDataUrl)
const boxStyle = computed(() => ({ width: props.size + 'px', height: props.size + 'px' }))
</script>

<template>
  <img
    v-if="logoUrl"
    class="brand-mark brand-mark--image"
    :src="logoUrl"
    :style="boxStyle"
    alt="系统 LOGO"
    draggable="false"
  >
  <!-- 兜底：完整版（登录页） -->
  <svg
    v-else-if="variant === 'full'"
    class="brand-mark"
    :style="boxStyle"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="fullGradientId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#06b6d4" />
        <stop offset="100%" stop-color="#0e7490" />
      </linearGradient>
      <linearGradient :id="fullAccentId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#22d3ee" />
        <stop offset="100%" stop-color="#0891b2" />
      </linearGradient>
    </defs>
    <ellipse cx="32" cy="38" rx="12" ry="14" :fill="'url(#' + fullGradientId + ')'" />
    <circle cx="32" cy="20" r="9" :fill="'url(#' + fullGradientId + ')'" />
    <path d="M32 11 C28 5 24 3 22 6 C26 7 29 9 32 11Z" :fill="'url(#' + fullAccentId + ')'" />
    <path d="M32 11 C32 4 35 1 38 4 C35 6 33 8 32 11Z" fill="#06b6d4" />
    <path d="M20 34 C10 26 8 32 10 38 C14 36 17 35 20 34Z" :fill="'url(#' + fullAccentId + ')'" opacity="0.9" />
    <path d="M20 34 C8 30 6 24 10 22 C13 28 16 31 20 34Z" fill="#22d3ee" opacity="0.7" />
    <path d="M44 34 C54 26 56 32 54 38 C50 36 47 35 44 34Z" :fill="'url(#' + fullAccentId + ')'" opacity="0.9" />
    <path d="M44 34 C56 30 58 24 54 22 C51 28 48 31 44 34Z" fill="#22d3ee" opacity="0.7" />
    <path d="M28 50 C24 56 20 60 18 58 C20 54 24 52 28 50Z" fill="#0891b2" opacity="0.8" />
    <path d="M32 52 C32 58 30 63 28 62 C29 58 30 55 32 52Z" fill="#06b6d4" opacity="0.9" />
    <path d="M36 50 C40 56 44 60 46 58 C44 54 40 52 36 50Z" fill="#0891b2" opacity="0.8" />
    <circle cx="29" cy="19" r="2.5" fill="white" />
    <circle cx="29.5" cy="19" r="1.2" fill="#0e7490" />
    <path d="M32 25 L29 28 L35 28Z" fill="#f0fdff" />
  </svg>
  <!-- 兜底：简化标记（侧栏 / 设置窗口 / 对话头像） -->
  <svg
    v-else
    class="brand-mark"
    :style="boxStyle"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="markGradientId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#06b6d4" />
        <stop offset="100%" stop-color="#0e7490" />
      </linearGradient>
    </defs>
    <ellipse cx="32" cy="38" rx="12" ry="14" :fill="'url(#' + markGradientId + ')'" />
    <circle cx="32" cy="20" r="9" :fill="'url(#' + markGradientId + ')'" />
    <circle cx="29" cy="19" r="2.5" fill="white" />
    <circle cx="29.5" cy="19" r="1.2" fill="#0e7490" />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: block;
  flex-shrink: 0;
}

/* 自定义图片：等比内缩放，允许非正方形 LOGO 完整可见 */
.brand-mark--image {
  object-fit: contain;
}
</style>
