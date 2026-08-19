<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { oauth2Api } from '@/services/oauth2Api'
import { useAuthStore } from '@/stores/auth'
import type { AuthorizeContextResponse } from '@/types/oauth2'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const loading = ref(true)
const approving = ref(false)
const error = ref('')
const context = ref<AuthorizeContextResponse | null>(null)

function appendQuery(url: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString()
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`
}

onMounted(async () => {
  const state = route.query.state as string | undefined
  if (!state) {
    error.value = '缺少授权参数'
    loading.value = false
    return
  }

  if (!authStore.isAuthenticated) {
    router.replace({
      name: 'login',
      query: { redirect: route.fullPath },
    })
    return
  }

  try {
    const res = await oauth2Api.getAuthorizeContext(state)
    context.value = res.data.data
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载授权信息失败'
  } finally {
    loading.value = false
  }
})

async function handleApprove() {
  if (!context.value) return
  approving.value = true
  try {
    const res = await oauth2Api.approve(context.value.state)
    window.location.assign(res.data.data.redirectUrl)
  } catch (err) {
    approving.value = false
    const message = err instanceof Error ? err.message : '授权失败'
    error.value = message
    ElMessage.error(message)
  }
}

function handleCancel() {
  if (!context.value) return
  const cancelUrl = appendQuery(context.value.redirectUri, {
    error: 'access_denied',
    state: context.value.state,
  })
  window.location.assign(cancelUrl)
}
</script>

<template>
  <div class="oauth2-authorize-view">
    <div v-if="loading" class="oauth2-state">正在加载授权信息...</div>
    <div v-else-if="error" class="oauth2-state oauth2-state--error">{{ error }}</div>
    <el-card v-else-if="context" class="authorize-card">
      <template #header>
        <div class="authorize-header">
          <span>授权确认</span>
        </div>
      </template>

      <div class="authorize-body">
        <p class="authorize-tip">
          <strong>{{ context.client.client_name }}</strong>
          请求访问你的账号数据
        </p>

        <div class="account-info">
          <el-avatar :size="48" :src="context.user.avatar || undefined">
            {{ context.user.nickname?.slice(0, 1) || 'U' }}
          </el-avatar>
          <div>
            <div class="account-name">{{ context.user.nickname || '未命名用户' }}</div>
            <div class="account-sub">登录账号将授权给该客户端</div>
          </div>
        </div>

        <div class="scope-list">
          <div class="scope-title">该客户端请求以下权限：</div>
          <div v-for="scope in context.scopes" :key="scope.key" class="scope-item">
            <span class="scope-label">{{ scope.label }}</span>
            <span class="scope-key">{{ scope.key }}</span>
          </div>
        </div>
      </div>

      <div class="authorize-actions">
        <el-button :disabled="approving" @click="handleCancel">取消</el-button>
        <el-button type="primary" :loading="approving" @click="handleApprove">
          授权
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.oauth2-authorize-view {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--color-bg-page);
}

.oauth2-state {
  color: var(--color-text-secondary);
  font-size: 16px;
}

.oauth2-state--error {
  color: var(--color-text-error);
}

.authorize-card {
  width: min(520px, 100%);
}

.authorize-header {
  font-size: 18px;
  font-weight: 700;
}

.authorize-body {
  display: grid;
  gap: 20px;
}

.authorize-tip {
  margin: 0;
  color: var(--color-text-primary);
  line-height: 1.6;
}

.account-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  background: var(--color-bg-form-area);
}

.account-name {
  font-weight: 600;
  color: var(--color-text-primary);
}

.account-sub {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.scope-list {
  display: grid;
  gap: 8px;
}

.scope-title {
  color: var(--color-text-primary);
  font-weight: 600;
}

.scope-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.scope-label {
  color: var(--color-text-primary);
}

.scope-key {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.authorize-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
</style>
