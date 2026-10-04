<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from './store/settings'
import ToastHost from './components/ToastHost.vue'

// 系统设置：首帧后立即加载（字体缩放/语言等运行时效果全局生效）
const settingsStore = useSettingsStore()
onMounted(() => {
  void settingsStore.load()
})
</script>

<template>
  <router-view />
  <!-- 全局 toast 宿主：各组件经 composables/useToast 的 showToast 触发 -->
  <ToastHost />
</template>
