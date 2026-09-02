<script setup lang="ts">
import { computed } from 'vue'
import { useUserStore } from '@store/user'

defineEmits<{
  logout: []
}>()

const userStore = useUserStore()

/** 显示名：用户名 → 手机号 → 兜底文案（与主页侧栏用户信息一致） */
const displayName = computed(
  () => userStore.userInfo?.username || userStore.userInfo?.mobile || 'KE-WORK用户'
)

/** 头像取显示名首字符 */
const avatarInitial = computed(() => displayName.value.trim().charAt(0).toUpperCase() || 'K')

/** 副标题：展示与主显示名不同的另一项真实账号信息（手机号 / 用户名） */
const accountDetail = computed(() => {
  const { username, mobile } = userStore.userInfo ?? {}
  if (mobile && mobile !== displayName.value) return '手机号：' + mobile
  if (username && username !== displayName.value) return '用户名：' + username
  return ''
})

/** 打开系统浏览器跳转到 Web 版首页 */
const openWebHome = async (): Promise<void> => {
  try {
    await window.api.openWebHome()
  } catch (err) {
    console.error('[AccountPage] open web home failed:', err)
  }
}
</script>

<template>
  <div class="s-page">
    <!-- 账户 -->
    <section class="s-card">
      <div class="s-row">
        <div class="s-account">
          <div class="s-avatar">
            {{ avatarInitial }}
          </div>
          <div>
            <h2 class="s-sec-title">
              {{ displayName }}
            </h2>
            <p v-if="accountDetail" class="s-desc s-desc--mt">
              {{ accountDetail }}
            </p>
          </div>
        </div>
        <button class="s-manage-btn" @click="openWebHome">
          前往管理中心
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </section>

    <button class="s-logout-btn" @click="$emit('logout')">退出登录</button>
  </div>
</template>

<style scoped>
.s-page {
  max-width: 1060px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 32px;
}

.s-desc--mt {
  margin-top: 4px;
}

.s-account {
  display: flex;
  align-items: center;
  gap: 16px;
}

.s-avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #3b82f6;
  color: var(--kw-color-on-accent);
  font-size: 22px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.s-manage-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  color: #59636b;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.s-manage-btn:hover {
  background: var(--kw-color-surface);
  color: var(--kw-color-text);
}

.s-logout-btn {
  align-self: flex-start;
  border: 1px solid #dde1e3;
  background: var(--kw-color-surface);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #59636b;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.s-logout-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}
</style>
