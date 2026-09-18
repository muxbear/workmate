<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useUserStore } from '@store/user'
import { useSettingsStore } from '../../../store/settings'
import SettingToggle from '../SettingToggle.vue'
import type { OAuth2ScopeDescriptor } from '../../../../../preload/index.d'

defineEmits<{
  logout: []
}>()

const userStore = useUserStore()
const settingsStore = useSettingsStore()

const scopes = ref<OAuth2ScopeDescriptor[]>([])
const scopeError = ref('')
const scopeLoading = ref(false)
/** 正在切换的 scope key（行内 loading / 防重复点击） */
const busyKey = ref('')

/** 显示名：用户名 → 手机号 → 兜底文案（与主页侧栏用户信息一致） */
const displayName = computed(
  () =>
    userStore.userInfo?.username || userStore.userInfo?.mobile || settingsStore.systemName + '用户'
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

const grantedCount = computed(() => scopes.value.filter((scope) => scope.granted).length)

/** 按分组聚合（保持主进程返回顺序） */
const groupedScopes = computed(() => {
  const groups: { name: string; items: OAuth2ScopeDescriptor[] }[] = []
  for (const scope of scopes.value) {
    const name = scope.group || '其他'
    const found = groups.find((group) => group.name === name)
    if (found) found.items.push(scope)
    else groups.push({ name, items: [scope] })
  }
  return groups
})

/** 打开系统浏览器跳转到 Web 版首页 */
const openWebHome = async (): Promise<void> => {
  try {
    await window.api.openWebHome()
  } catch (err) {
    console.error('[AccountPage] open web home failed:', err)
  }
}

async function loadScopes(): Promise<void> {
  scopeLoading.value = true
  scopeError.value = ''
  try {
    const result = await window.api.oauth2.getScopeCatalog()
    if (!result.success) throw new Error(result.error || '读取授权信息失败')
    scopes.value = result.data ?? []
  } catch (err) {
    scopeError.value = err instanceof Error ? err.message : '读取授权信息失败'
  } finally {
    scopeLoading.value = false
  }
}

/** 开关切换：开启=按需授权，关闭=撤销该 scope 授权 */
async function toggleScope(scope: OAuth2ScopeDescriptor): Promise<void> {
  if (scope.required || busyKey.value) return
  const next = !scope.granted
  busyKey.value = scope.key
  scopeError.value = ''
  try {
    const result = next
      ? await window.api.oauth2.authorize([scope.key])
      : await window.api.oauth2.revoke([scope.key])
    if (!result.success) throw new Error(result.error || '操作失败')
    await loadScopes()
  } catch (err) {
    scopeError.value = err instanceof Error ? err.message : '操作失败'
  } finally {
    busyKey.value = ''
  }
}

onMounted(() => {
  void loadScopes()
})
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

    <!-- 授权管理：Web 端 OAuth2 权限（默认全开，可按需关闭） -->
    <section class="s-card">
      <div class="s-row s-row--top">
        <div>
          <h2 class="s-sec-title">授权管理</h2>
          <p class="s-desc s-desc--mt">
            已授权 {{ grantedCount }} / {{ scopes.length }} 项。默认全开时只需授权一次，
            专家、技能、模型等入口会直接复用；关闭某项后，仅对应功能在下次使用时重新请求授权。
          </p>
        </div>
      </div>

      <p v-if="scopeError" class="s-scope-error">{{ scopeError }}</p>
      <p v-else-if="scopeLoading" class="s-desc s-scope-state">正在加载授权信息…</p>
      <p v-else-if="scopes.length === 0" class="s-desc s-scope-state">
        尚未完成 Web 授权：在专家 / 技能 / 模型等页面点击同步时会自动发起授权。
      </p>

      <div v-else class="s-scope-list">
        <div v-for="group in groupedScopes" :key="group.name" class="s-scope-group">
          <div class="s-scope-group-title">{{ group.name }}</div>
          <div v-for="scope in group.items" :key="scope.key" class="s-scope-item">
            <div class="s-scope-main">
              <div class="s-scope-label">
                {{ scope.label }}
                <span v-if="scope.required" class="s-scope-tag">必需</span>
              </div>
              <div class="s-desc s-scope-desc">{{ scope.description }}</div>
              <div v-if="!scope.granted && !scope.required" class="s-scope-hint">
                已关闭，预计 90 天后恢复默认开启
              </div>
            </div>
            <SettingToggle
              :model-value="scope.granted"
              :disabled="scope.required || busyKey === scope.key"
              @update:model-value="toggleScope(scope)"
            />
          </div>
        </div>
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

.s-row--top {
  align-items: flex-start;
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

.s-scope-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.s-scope-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.s-scope-group-title {
  font-size: 12px;
  color: var(--kw-color-text-muted);
}

.s-scope-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: 1px solid #f3f4f6;
  border-radius: 10px;
  background: var(--kw-color-surface);
}

.s-scope-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.s-scope-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.s-scope-tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  background: #f3f4f6;
  color: var(--kw-color-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.s-scope-desc {
  font-size: 12px;
}

.s-scope-hint {
  font-size: 11px;
  color: #f59e0b;
}

.s-scope-state {
  margin-top: 12px;
}

.s-scope-error {
  margin-top: 12px;
  font-size: 12px;
  color: #ef4444;
}

.s-manage-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  color: var(--kw-color-brand);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
}
</style>
