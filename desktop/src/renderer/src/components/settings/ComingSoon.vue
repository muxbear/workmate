<script setup lang="ts">
/**
 * 「即将上线」标注（R7-8）：用于尚无后端实现、暂不生效的设置项 / 区块。
 *
 * - variant="tag"（缺省）：小徽标，挂在假开关所在区块的标题旁；
 * - variant="banner"：整页/整区提示条，用于整页未接入的假设置页。
 *
 * 约定：被标注的控件同时传 `disabled`，避免「点一下像生效了」的错觉；
 * 页面若有伪造的反馈文案（如假成功提示），一并撤除或不可达。
 */
withDefaults(defineProps<{ variant?: 'tag' | 'banner' }>(), { variant: 'tag' })
</script>

<template>
  <span
    v-if="variant === 'tag'"
    class="cs-tag"
  >即将上线</span>
  <p
    v-else
    class="cs-banner"
  >
    <span class="cs-tag">即将上线</span>
    <span class="cs-banner-text">本页设置尚未接入后端，暂时不生效。</span>
  </p>
</template>

<style scoped>
.cs-tag {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.cs-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--kw-color-brand-soft);
  background: var(--kw-color-brand-soft);
}

.cs-banner-text {
  font-size: 13px;
  color: var(--kw-color-brand-strong);
  line-height: 1.4;
}
</style>
