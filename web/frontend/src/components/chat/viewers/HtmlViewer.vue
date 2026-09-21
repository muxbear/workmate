<script setup lang="ts">
import type { DocumentPayload } from '@/types/document'

/** HTML 文档组件：沙箱 iframe 渲染（不执行脚本，避免产物内容影响主页面） */
defineProps<{ payload: DocumentPayload }>()
</script>

<template>
  <iframe class="html-viewer" sandbox="" title="HTML 文档预览" :srcdoc="payload.text"></iframe>
</template>

<style scoped>
.html-viewer {
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: none;
  border-radius: var(--radius-lg);
  background: #fff;
}
</style>
