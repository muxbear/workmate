<script setup lang="ts">
import FeatureGrid from './FeatureGrid.vue'
import BrandMark from '@/components/common/BrandMark.vue'
import { useBrandStore } from '@/stores/brand'

// 登录页在 MainLayout 之外，品牌状态由 main.ts 在启动时拉取（公开接口，未登录也能取）
const brandStore = useBrandStore()
</script>

<template>
  <div class="brand-panel">
    <!-- Top spacer -->
    <div class="brand-spacer" />

    <!-- Content wrapper -->
    <div class="brand-content">
      <!-- Logo -->
      <div class="brand-logo">
        <BrandMark :src="brandStore.logoDisplaySrc" />
      </div>

      <!-- System name -->
      <h1 class="brand-name">{{ brandStore.systemName }}</h1>

      <!-- Tagline -->
      <p class="brand-tagline">自我进化，越用越强</p>

      <!-- Feature grid -->
      <FeatureGrid />
    </div>

    <!-- Bottom spacer -->
    <div class="brand-spacer" />

    <!-- Copyright -->
    <footer class="brand-footer">2026 {{ brandStore.systemName }} 版权所有</footer>
  </div>
</template>

<style scoped>
.brand-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  padding: var(--size-brand-padding-v) var(--size-brand-padding-h);
}

.brand-spacer {
  flex: 1;
  min-height: 20px;
}

.brand-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-brand-block-gap);
}

.brand-logo {
  width: var(--size-logo);
  height: var(--size-logo);
  border-radius: var(--radius-logo);
  filter: drop-shadow(var(--shadow-logo));
  /* 自定义 LOGO 是 <img>，需要裁切才能跟随圆角 */
  overflow: hidden;
}

.brand-name {
  margin: 0;
  font-size: var(--font-size-system-name);
  font-weight: var(--font-weight-bold);
  color: #ffffff;
  letter-spacing: 0.02em;
}

.brand-tagline {
  margin: 0;
  font-size: var(--font-size-tagline);
  color: var(--color-text-label);
  letter-spacing: 0.04em;
}

.brand-footer {
  font-size: var(--font-size-copyright);
  color: var(--color-text-muted);
  opacity: 0.5;
}
</style>
