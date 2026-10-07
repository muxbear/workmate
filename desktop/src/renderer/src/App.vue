<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useSettingsStore } from './store/settings'
import type { WindowCloseChoice } from '../../shared/contracts'
import ToastHost from './components/ToastHost.vue'
import CloseConfirmDialog from './components/CloseConfirmDialog.vue'

// 系统设置：首帧后立即加载（字体缩放/语言等运行时效果全局生效）
const settingsStore = useSettingsStore()
onMounted(() => {
  void settingsStore.load()
})

// ── 主窗口关闭确认（主进程在 ui.closeAction='ask' 且用户点窗口关闭按钮时推送）──
const closeConfirmVisible = ref(false)
let unsubscribeCloseConfirm: (() => void) | null = null

onMounted(() => {
  unsubscribeCloseConfirm = window.api.onCloseConfirmRequest(() => {
    closeConfirmVisible.value = true
  })
})
onUnmounted(() => unsubscribeCloseConfirm?.())

/**
 * 作答关闭确认：'tray' | 'close'；null = 取消。
 * 落盘在主进程完成，渲染层镜像不会自动更新 —— 作答后回拉全量快照；
 * 此处严禁调用 settingsStore.set()（300ms 防抖会把设置页旧值回灌，覆盖主进程刚写入的选择）。
 */
async function respondCloseConfirm(choice: WindowCloseChoice | null): Promise<void> {
  closeConfirmVisible.value = false
  await window.api.answerCloseConfirm(choice)
  if (choice) await settingsStore.load()
}

function onChooseClose(choice: WindowCloseChoice): void {
  void respondCloseConfirm(choice)
}

function onCancelClose(): void {
  void respondCloseConfirm(null)
}
</script>

<template>
  <router-view />
  <!-- 全局关闭确认（登录页点 ✕ 同样覆盖；需压过设置浮层/下拉菜单/重命名遮罩）。
       父级 v-if 卸载：选「最小化到托盘」后窗口立即隐藏，隐藏窗口的渲染（含 rAF）被暂停，
       过渡离场会滞留 DOM —— v-if 同步卸载不依赖渲染（同 ConfirmDialog 契约） -->
  <CloseConfirmDialog v-if="closeConfirmVisible" @choose="onChooseClose" @cancel="onCancelClose" />
  <!-- 全局 toast 宿主：各组件经 composables/useToast 的 showToast 触发 -->
  <ToastHost />
</template>
