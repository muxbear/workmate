<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { oauth2Api } from '@/services/oauth2Api'
import { useAuthStore } from '@/stores/auth'
import type { AuthorizeContextResponse, OAuth2ScopeInfo } from '@/types/oauth2'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const loading = ref(true)
const approving = ref(false)
const error = ref('')
const context = ref<AuthorizeContextResponse | null>(null)
/** scope.key -> 开关是否开启（默认取 defaultGranted，即默认全开） */
const enabled = ref<Record<string, boolean>>({})
const grantedExpanded = ref(false)

/** 本次请求中尚未授权的 scope（增量授权时只列这些） */
const pendingScopes = computed<OAuth2ScopeInfo[]>(() =>
  (context.value?.scopes ?? []).filter((scope) => scope.granted !== true),
)
/** 本次请求中已授权的 scope（折叠展示） */
const grantedScopes = computed<OAuth2ScopeInfo[]>(() =>
  (context.value?.scopes ?? []).filter((scope) => scope.granted === true),
)
/** 按分组聚合未授权项（保持服务端返回顺序） */
const groupedPending = computed<{ name: string; items: OAuth2ScopeInfo[] }[]>(() => {
  const groups: { name: string; items: OAuth2ScopeInfo[] }[] = []
  for (const scope of pendingScopes.value) {
    const name = scope.group || '其他'
    const found = groups.find((item) => item.name === name)
    if (found) found.items.push(scope)
    else groups.push({ name, items: [scope] })
  }
  return groups
})
/** 提交给服务端的 scope（必选项始终保留） */
const selectedScopes = computed<string[]>(() =>
  pendingScopes.value
    .filter((scope) => scope.required === true || enabled.value[scope.key] === true)
    .map((scope) => scope.key),
)
const canApprove = computed<boolean>(() => {
  if (!context.value) return false
  if (pendingScopes.value.length === 0) return true
  return selectedScopes.value.length > 0
})

function isEnabled(scope: OAuth2ScopeInfo): boolean {
  return scope.required === true || enabled.value[scope.key] === true
}

function onScopeToggle(scope: OAuth2ScopeInfo, value: string | number | boolean): void {
  if (scope.required === true) return
  enabled.value[scope.key] = value === true
}

function appendQuery(url: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString()
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`
}

function applyContext(data: AuthorizeContextResponse): void {
  context.value = data
  const next: Record<string, boolean> = {}
  for (const scope of data.scopes) {
    next[scope.key] = scope.defaultGranted !== false
  }
  enabled.value = next
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
    applyContext(res.data.data)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载授权信息失败'
  } finally {
    loading.value = false
  }

  // 请求范围内权限均已授权：免二次确认，直接生成授权码回跳
  if (context.value?.autoApprove) {
    await handleApprove()
  }
})

async function handleApprove(): Promise<void> {
  if (!context.value || approving.value) return
  approving.value = true
  try {
    const scopes = pendingScopes.value.length > 0 ? selectedScopes.value : undefined
    const res = await oauth2Api.approve(context.value.state, scopes)
    window.location.assign(res.data.data.redirectUrl)
  } catch (err) {
    approving.value = false
    const message = err instanceof Error ? err.message : '授权失败'
    error.value = message
    ElMessage.error(message)
    // RFC 6749 §4.1.2.1：approve 失败应回跳 redirect_uri 携带 error，由客户端统一处理
    if (context.value) {
      const errorUrl = appendQuery(context.value.redirectUri, {
        error: 'server_error',
        error_description: message,
        state: context.value.state,
      })
      window.location.assign(errorUrl)
    }
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

        <div v-if="context.autoApprove" class="auto-approve-tip">
          已授权，正在返回应用…
        </div>

        <template v-else>
          <div class="account-info">
            <el-avatar :size="48" :src="context.user.avatar || undefined">
              {{ context.user.nickname?.slice(0, 1) || 'U' }}
            </el-avatar>
            <div>
              <div class="account-name">{{ context.user.nickname || '未命名用户' }}</div>
              <div class="account-sub">登录账号将授权给该客户端</div>
            </div>
          </div>

          <div v-if="pendingScopes.length > 0" class="scope-list">
            <div class="scope-title">该客户端请求以下权限（默认全部开启，可逐项关闭）：</div>
            <div v-for="group in groupedPending" :key="group.name" class="scope-group">
              <div class="scope-group-title">{{ group.name }}</div>
              <div v-for="scope in group.items" :key="scope.key" class="scope-item">
                <div class="scope-main">
                  <div class="scope-label">
                    {{ scope.label }}
                    <span v-if="scope.required" class="scope-required">登录必需</span>
                  </div>
                  <div class="scope-desc">{{ scope.description || scope.key }}</div>
                </div>
                <el-switch
                  :model-value="isEnabled(scope)"
                  :disabled="scope.required === true"
                  @update:model-value="onScopeToggle(scope, $event)"
                />
              </div>
            </div>
            <p v-if="selectedScopes.length === 0" class="scope-warning">
              至少保留一项权限
            </p>
          </div>

          <div v-if="grantedScopes.length > 0" class="granted-block">
            <button
              class="granted-toggle"
              type="button"
              @click="grantedExpanded = !grantedExpanded"
            >
              已授权 {{ grantedScopes.length }} 项{{ grantedExpanded ? '（收起）' : '（展开查看）' }}
            </button>
            <ul v-if="grantedExpanded" class="granted-list">
              <li v-for="scope in grantedScopes" :key="scope.key">
                {{ scope.label }}（{{ scope.key }}）
              </li>
            </ul>
          </div>
        </template>
      </div>

      <div class="authorize-actions">
        <el-button :disabled="approving" @click="handleCancel">取消</el-button>
        <el-button
          type="primary"
          :loading="approving"
          :disabled="!canApprove"
          @click="handleApprove"
        >
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
  width: min(560px, 100%);
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

.auto-approve-tip {
  padding: 12px;
  border-radius: 10px;
  background: var(--color-bg-form-area);
  color: var(--color-text-secondary);
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

.scope-group {
  display: grid;
  gap: 8px;
  margin-top: 4px;
}

.scope-group-title {
  color: var(--color-text-secondary);
  font-size: 12px;
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

.scope-main {
  display: grid;
  gap: 4px;
}

.scope-label {
  color: var(--color-text-primary);
}

.scope-required {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--color-bg-form-area);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.scope-desc {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.scope-warning {
  margin: 0;
  color: var(--color-text-error);
  font-size: 12px;
}

.granted-block {
  display: grid;
  gap: 6px;
}

.granted-toggle {
  justify-self: start;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.granted-list {
  margin: 0;
  padding-left: 18px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.8;
}

.authorize-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
</style>
