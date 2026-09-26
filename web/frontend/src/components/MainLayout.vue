<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNotificationStore } from '@/stores/notification'
import { useAuthStore } from '@/stores/auth'
import SideMenu from './SideMenu.vue'
import TopBar from './TopBar.vue'
import { usePermissionStore } from '@/stores/permission'
import { useUiStore } from '@/stores/ui'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const route = useRoute()
const router = useRouter()

const uiStore = useUiStore()
/** 窄屏自动收起侧栏的卸载函数（见 ui store 的 initResponsiveSidebar） */
let disposeResponsiveSidebar: (() => void) | null = null

onMounted(async () => {
  disposeResponsiveSidebar = uiStore.initResponsiveSidebar()
  const permStore = usePermissionStore()
  if (!permStore.loaded) {
    await permStore.load()
  }
  // 若刷新后当前路由不在新角色权限内，跳到第一个可用菜单
  const permKey = route.meta.permKey as string | undefined
  if (permKey && !permStore.hasPermission(permKey)) {
    router.replace(permStore.firstMenuPath)
  }
  if (authStore.isAuthenticated) {
    notificationStore.init()
  }
})

onUnmounted(() => {
  disposeResponsiveSidebar?.()
  notificationStore.disconnectSSE()
})
</script>

<template>
  <div class="main-layout">
    <SideMenu />
    <div class="right-area">
      <TopBar />
      <div class="work-area">
        <RouterView />
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-layout {
  display: flex;
  height: 100vh;
  background: var(--surface-primary);
}

.right-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.work-area {
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
</style>
