<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useNotificationStore } from '@/stores/notification'
import { useAuthStore } from '@/stores/auth'
import SideMenu from './SideMenu.vue'
import TopBar from './TopBar.vue'
import { usePermissionStore } from '@/stores/permission'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()

onMounted(() => {
  const permStore = usePermissionStore()
  if (!permStore.loaded) {
    permStore.load()
  }
  if (authStore.isAuthenticated) {
    notificationStore.init()
  }
})

onUnmounted(() => {
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
