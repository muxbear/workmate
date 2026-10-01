<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNotificationStore } from '@/stores/notification'
import { useAuthStore } from '@/stores/auth'
import SideMenu from './SideMenu.vue'
import TopBar from './TopBar.vue'
import SettingsWindow from '@/components/settings/SettingsWindow.vue'
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
    // 偏好是登录态接口，必须放在这里而不是 main.ts：匿名首屏调用必然 401，
    // 而 request 拦截器会把 401 变成跳 /login，在登录页上会自我重定向成死循环。
    // MainLayout 只在 meta.requiresAuth 之后挂载，且已经承载了权限与通知的初始化。
    void uiStore.loadPreferences(authStore.user?.id ?? null)
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

    <!-- 设置是弹出窗口而不是独立页面（与桌面版同形），入口在 TopBar 的用户下拉 -->
    <SettingsWindow />
  </div>
</template>

<style scoped>
.main-layout {
  display: flex;
  /* 用 100% 而不是 100vh：字号偏好会给根元素加 zoom，vh 在 zoom 下的表现
     最不可预测。父链已支持百分比（main.css 的 html/body 与 #app 都是 100%）。 */
  height: 100%;
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
