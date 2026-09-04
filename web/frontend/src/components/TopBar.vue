<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  Search,
  Bell,
  CircleUser,
  LogOut,
  ChevronRight,
  Settings,
  Palette,
  KeyRound,
} from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import { useUiStore } from '@/stores/ui'
import { useNotificationStore } from '@/stores/notification'
import NotificationPanel from './NotificationPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useAuth } from '@/composables/useAuth'
import { authApi } from '@/services/authApi'
import { usePasswordEncrypt } from '@/composables/usePasswordEncrypt'

const route = useRoute()
const uiStore = useUiStore()
const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const { logout } = useAuth()
const { publicKey, fetchPublicKey, encrypt } = usePasswordEncrypt()

// 修改密码弹窗状态
const changePwdVisible = ref(false)
const changePwdLoading = ref(false)
const changePwdForm = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
})

const userMenuOpen = ref(false)
const searchFocused = ref(false)

const displayName = computed(() => {
  return authStore.user?.nickname || '未登录'
})

const breadcrumb = computed(() => {
  const map: Record<string, { group: string; item: string }> = {
    '/chat': { group: '聊天', item: '对话' },
    '/agents': { group: '代理', item: '代理' },
    '/skills': { group: '代理', item: '技能 Hub' },
    '/overview': { group: '首页', item: '概览' },
    '/models': { group: '首页', item: '模型' },
    '/scheduled-tasks': { group: '首页', item: '定时任务' },
    '/tools': { group: '智能体', item: '工具' },
    '/mcp': { group: 'MCP', item: 'MCP 广场' },
    '/knowledge-base': { group: '知识库', item: '知识库' },
    '/admin': { group: '管理', item: '后台管理' },
    '/admin/users': { group: '管理', item: '人员管理' },
    '/admin/rbac': { group: '管理', item: '角色权限' },
    '/admin/resources': { group: '管理', item: '资源管理' },
    '/admin/announcements': { group: '管理', item: '公告管理' },
  }
  const path = route.path
  if (map[path]) return map[path]
  if (path.startsWith('/admin/')) return map['/admin']
  if (path.startsWith('/mcp/')) return map['/mcp']
  return map[path] ?? null
})

function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value
}

function handleSettings() {
  userMenuOpen.value = false
  ElMessage.info('设置页面开发中')
}

function openChangePassword() {
  userMenuOpen.value = false
  changePwdForm.oldPassword = ''
  changePwdForm.newPassword = ''
  changePwdForm.confirmPassword = ''
  changePwdVisible.value = true
}

async function submitChangePassword() {
  // 前端校验：先判断原始密码不为空
  if (!changePwdForm.oldPassword) {
    ElMessage.warning('请输入原始密码')
    return
  }
  // 再判断新密码不为空
  if (!changePwdForm.newPassword) {
    ElMessage.warning('请输入新密码')
    return
  }
  // 判断新密码与确认密码是否一致
  if (changePwdForm.newPassword !== changePwdForm.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  // 新密码不能与原始密码相同
  if (changePwdForm.newPassword === changePwdForm.oldPassword) {
    ElMessage.warning('新密码不能与原始密码相同')
    return
  }

  changePwdLoading.value = true
  try {
    // RSA 加密密码
    await fetchPublicKey()
    let encryptedOld = changePwdForm.oldPassword
    let encryptedNew = changePwdForm.newPassword
    if (publicKey.value) {
      encryptedOld = encrypt(changePwdForm.oldPassword)
      encryptedNew = encrypt(changePwdForm.newPassword)
    }

    await authApi.changePassword({
      oldPassword: encryptedOld,
      newPassword: encryptedNew,
    })

    ElMessage.success('密码修改成功，请重新登录')
    changePwdVisible.value = false
    // 修改成功后注销当前用户，跳转到登录页
    await logout()
  } catch (err: any) {
    const msg = err?.message || err?.response?.data?.message || '密码修改失败'
    ElMessage.error(msg)
  } finally {
    changePwdLoading.value = false
  }
}

async function handleLogout() {
  userMenuOpen.value = false
  await logout()
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('.user-menu-wrap')) {
    userMenuOpen.value = false
  }
}

function handleSearchInput(e: Event) {
  const target = e.target as HTMLInputElement
  uiStore.searchQuery = target.value
}

function clearSearch() {
  uiStore.searchQuery = ''
}

// Click outside to close user menu
import { watch } from 'vue'
watch(userMenuOpen, (open) => {
  if (open) {
    document.addEventListener('click', handleClickOutside)
  } else {
    document.removeEventListener('click', handleClickOutside)
  }
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="topbar">
    <div class="topbar-left">
      <div v-if="breadcrumb" class="breadcrumb">
        <span class="breadcrumb-group">{{ breadcrumb.group }}</span>
        <ChevronRight :size="14" class="breadcrumb-sep" />
        <span class="breadcrumb-item">{{ breadcrumb.item }}</span>
      </div>
    </div>
    <div class="topbar-right">
      <div class="search-box" :class="{ focused: searchFocused }">
        <Search :size="16" class="search-icon" />
        <input
          :value="uiStore.searchQuery"
          type="text"
          placeholder="搜索对话、技能、设置..."
          @input="handleSearchInput"
          @focus="searchFocused = true"
          @blur="searchFocused = false"
        />
        <button v-if="uiStore.searchQuery" class="search-clear" @click="clearSearch">
          &times;
        </button>
      </div>
      <el-popover trigger="click" placement="bottom-end" :width="380" popper-class="notification-popper">
        <template #reference>
          <button class="action-btn" title="通知">
            <Bell :size="18" />
            <span v-if="notificationStore.unreadCount > 0" class="badge">
              {{ notificationStore.unreadCount > 99 ? '99+' : notificationStore.unreadCount }}
            </span>
          </button>
        </template>
        <NotificationPanel />
      </el-popover>

      <!-- User menu -->
      <div class="user-menu-wrap">
        <button class="user-btn" :class="{ active: userMenuOpen }" @click.stop="toggleUserMenu">
          <CircleUser :size="18" />
          <span class="user-name">{{ displayName }}</span>
        </button>

        <Transition name="menu">
          <div v-if="userMenuOpen" class="user-dropdown">
            <div class="user-dropdown-header">
              <span class="user-avatar">
                {{ displayName.charAt(0) }}
              </span>
              <span class="user-fullname">{{ displayName }}</span>
            </div>
            <div class="user-dropdown-divider" />
            <button class="user-dropdown-item" @click="handleSettings">
              <Settings :size="14" />
              <span>设置</span>
            </button>
            <div class="user-dropdown-item appearance-item">
              <Palette :size="14" />
              <span>外观</span>
              <button
                class="theme-switch"
                :class="{ dark: uiStore.theme === 'dark' }"
                role="switch"
                :aria-checked="uiStore.theme === 'dark'"
                @click.stop="uiStore.toggleTheme"
              >
                <span class="theme-option">浅色</span>
                <span class="theme-option">深色</span>
                <span class="theme-thumb" />
              </button>
            </div>
            <div class="user-dropdown-divider" />
            <button class="user-dropdown-item" @click="openChangePassword">
              <KeyRound :size="14" />
              <span>修改密码</span>
            </button>
            <div class="user-dropdown-divider" />
            <button class="user-dropdown-item logout" @click="handleLogout">
              <LogOut :size="14" />
              <span>退出登录</span>
            </button>
          </div>
        </Transition>
      </div>
    </div>
  </div>

  <!-- 修改密码弹窗 -->
  <el-dialog
    v-model="changePwdVisible"
    title="修改密码"
    width="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form label-width="90px" @submit.prevent="submitChangePassword">
      <el-form-item label="原始密码">
        <el-input
          v-model="changePwdForm.oldPassword"
          type="password"
          placeholder="请输入原始密码"
          show-password
        />
      </el-form-item>
      <el-form-item label="新设密码">
        <el-input
          v-model="changePwdForm.newPassword"
          type="password"
          placeholder="请输入新密码"
          show-password
        />
      </el-form-item>
      <el-form-item label="确认密码">
        <el-input
          v-model="changePwdForm.confirmPassword"
          type="password"
          placeholder="请再次输入新密码"
          show-password
          @keyup.enter="submitChangePassword"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="changePwdVisible = false">取消</el-button>
      <el-button type="primary" :loading="changePwdLoading" @click="submitChangePassword"
        >确认</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.topbar {
  height: var(--topbar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px;
  background: var(--surface-card);
  border-bottom: 1px solid var(--border-subtle);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
}

.breadcrumb-group {
  color: var(--foreground-muted);
}

.breadcrumb-sep {
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.breadcrumb-item {
  color: var(--foreground-primary);
  font-weight: var(--font-weight-medium);
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 360px;
  padding: 6px 12px;
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
  border: 1px solid transparent;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.search-box.focused {
  border-color: var(--accent-primary);
  background: var(--color-bg-input);
}

.search-icon {
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.search-box input {
  width: 100%;
  border: none;
  outline: none;
  background: none;
  font-size: var(--font-size-base);
  color: var(--foreground-primary);
}

.search-box input::placeholder {
  color: var(--foreground-muted);
}

.search-clear {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: var(--foreground-muted);
  color: var(--surface-primary);
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.action-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.action-btn:hover {
  background: var(--surface-secondary);
}

.badge {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--color-text-error, #f87171);
  color: white;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.action-btn {
  position: relative;
}

/* User menu */
.user-menu-wrap {
  position: relative;
}

.user-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-subtle);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: border-color var(--transition-fast);
}

.user-btn:hover,
.user-btn.active {
  border-color: var(--accent-primary);
  color: var(--foreground-primary);
}

.user-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 236px;
  background: var(--surface-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  z-index: 200;
  overflow: hidden;
}

.user-dropdown-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
}

.user-avatar {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  background: var(--accent-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: var(--font-weight-bold);
  flex-shrink: 0;
}

.user-fullname {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.user-dropdown-divider {
  height: 1px;
  background: var(--border-subtle);
}

.user-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: none;
  color: var(--foreground-secondary);
  font-size: var(--font-size-base);
  cursor: pointer;
}

.user-dropdown-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.user-dropdown-item.appearance-item {
  cursor: default;
  justify-content: flex-start;
}

.user-dropdown-item.appearance-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.theme-switch {
  position: relative;
  display: flex;
  align-items: center;
  width: 102px;
  height: 24px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-secondary);
  cursor: pointer;
  overflow: hidden;
  flex-shrink: 0;
}

.theme-option {
  position: relative;
  z-index: 1;
  flex: 1;
  font-size: var(--font-size-xs);
  line-height: 18px;
  text-align: center;
  color: var(--foreground-muted);
  transition: color var(--transition-fast);
}

.theme-switch:not(.dark) .theme-option:first-child,
.theme-switch.dark .theme-option:last-child {
  color: var(--foreground-primary);
}

.theme-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 47px;
  height: 18px;
  border-radius: var(--radius-full);
  background: var(--surface-card);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform var(--transition-fast);
}

.theme-switch.dark .theme-thumb {
  transform: translateX(49px);
}

.user-dropdown-item.logout:hover {
  background: rgba(240, 69, 69, 0.1);
  color: var(--color-text-error);
}

/* Menu transition */
.menu-enter-active,
.menu-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
