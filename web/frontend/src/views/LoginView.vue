<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import LoginCard from '@/components/auth/LoginCard.vue'
import LoginTabs from '@/components/auth/LoginTabs.vue'
import AccountLoginForm from '@/components/auth/AccountLoginForm.vue'
import PhoneLoginForm from '@/components/auth/PhoneLoginForm.vue'
import AgreementCheckbox from '@/components/auth/AgreementCheckbox.vue'
import OAuthPanel from '@/components/auth/OAuthPanel.vue'
import RegisterLink from '@/components/auth/RegisterLink.vue'
import CaptchaModal from '@/components/captcha/CaptchaModal.vue'
import { useAuth } from '@/composables/useAuth'
import { ApiError } from '@/services/request'
import type { CaptchaResult } from '@/types/components'

const activeTab = ref<'account' | 'phone'>('account')
const { loading, error, loginWithPassword, loginWithPhone, fetchLoginChallenge } = useAuth()
const agreementChecked = ref(true)
const agreementShake = ref(false)

const accountFormRef = ref<InstanceType<typeof AccountLoginForm> | null>(null)
const phoneFormRef = ref<InstanceType<typeof PhoneLoginForm> | null>(null)

const submitError = ref<string | null>(null)

// ---- 登录安全验证（滑块）状态 ----

/** 登录提交载荷（含安全验证票据） */
interface LoginPayload {
  account?: string
  password?: string
  rememberMe?: boolean
  phone?: string
  smsCode?: string
  captchaTicket?: string
  captchaRandstr?: string
}

const captchaVisible = ref(false)
const captchaAccount = ref('')
const pendingLogin = ref<LoginPayload | null>(null)

/** 打开滑块验证，并暂存本次登录输入 */
function openCaptcha(data: LoginPayload) {
  pendingLogin.value = data
  captchaAccount.value = data.account ?? ''
  captchaVisible.value = true
}

/** 手动关闭滑块时放弃本次提交 */
function onCaptchaVisibleChange(visible: boolean) {
  if (!visible) pendingLogin.value = null
}

/** 滑块验证通过后，携带票据重试登录 */
function onCaptchaSuccess(result: CaptchaResult) {
  captchaVisible.value = false
  const data = pendingLogin.value
  pendingLogin.value = null
  if (!data) return
  void doLogin({ ...data, captchaTicket: result.ticket, captchaRandstr: result.randstr })
}

/** 服务端返回 428 表示需要先完成安全验证 */
function isCaptchaRequired(err: unknown): boolean {
  return err instanceof ApiError && Number(err.code) === 428
}

/** 查询挑战状态；接口异常时不阻断登录（服务端仍会拦截） */
async function loadLoginChallenge(account: string) {
  try {
    return await fetchLoginChallenge(account)
  } catch {
    return null
  }
}

/** 账号密码登录：必要时先完成滑块验证 */
async function loginAccount(data: LoginPayload) {
  if (!data.captchaTicket) {
    const challenge = await loadLoginChallenge(data.account ?? '')
    if (challenge?.required) {
      openCaptcha(data)
      return
    }
  }
  await loginWithPassword(data.account ?? '', data.password ?? '', data.rememberMe ?? false, {
    ticket: data.captchaTicket,
    randstr: data.captchaRandstr,
  })
}

async function doLogin(data: LoginPayload) {
  submitError.value = null

  if (!agreementChecked.value) {
    agreementShake.value = true
    ElMessage.warning('请先阅读并同意用户协议')
    setTimeout(() => { agreementShake.value = false }, 2000)
    return
  }

  try {
    if ('account' in data && data.account) {
      await loginAccount(data)
    } else if ('phone' in data && data.phone) {
      await loginWithPhone(data.phone, data.smsCode!)
    }
  } catch (err: unknown) {
    // 服务端要求先完成安全验证：弹出滑块，验证通过后带票据重试
    if (isCaptchaRequired(err) && data.account) {
      openCaptcha(data)
      submitError.value = '请完成安全验证后继续登录'
      return
    }
    const msg = err instanceof Error ? err.message : '登录失败，请稍后重试'
    submitError.value = msg
    ElMessage.error(msg)
  }
}

/** 按钮点击 → 触发表单验证 → 验证通过后 emit('submit') → doLogin */
function handleSubmit() {
  const formRef = activeTab.value === 'account' ? accountFormRef.value : phoneFormRef.value
  if (!formRef) return
  formRef.submit()
}
</script>

<template>
  <div class="login-view">
    <LoginCard :loading="loading">
      <LoginTabs v-model="activeTab" />

      <div class="form-area">
        <div
          :class="{ 'form-panel': true, hidden: activeTab !== 'account' }"
        >
          <AccountLoginForm ref="accountFormRef" @submit="doLogin" />
        </div>
        <div
          :class="{ 'form-panel': true, hidden: activeTab !== 'phone' }"
        >
          <PhoneLoginForm ref="phoneFormRef" @submit="doLogin" />
        </div>
      </div>

      <div v-if="submitError" class="login-error">{{ submitError }}</div>
      <div v-else-if="error" class="login-error">{{ error }}</div>

      <el-button
        type="primary"
        size="large"
        class="login-btn"
        :loading="loading"
        @click="handleSubmit"
      >
        登录
      </el-button>

      <AgreementCheckbox v-model="agreementChecked" :class="{ shake: agreementShake }" />

      <OAuthPanel />

      <RegisterLink />
    </LoginCard>

    <CaptchaModal
      v-model="captchaVisible"
      scene="login"
      :account="captchaAccount"
      @success="onCaptchaSuccess"
      @update:model-value="onCaptchaVisibleChange"
    />
  </div>
</template>

<style scoped>
.login-view {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.form-area {
  display: grid;
}

.form-area > * {
  grid-area: 1 / 1;
}

.form-panel {
  transition: opacity 0.2s ease, visibility 0.2s ease;
}

.form-panel.hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.login-error {
  color: var(--color-text-error);
  font-size: var(--font-size-agreement);
  text-align: center;
}

.login-btn {
  height: var(--size-button-height);
  border-radius: var(--radius-button);
  background: var(--color-accent-gradient);
  border: none;
  font-size: var(--font-size-button);
  font-weight: var(--font-weight-bold);
  box-shadow: var(--shadow-button);
}

.login-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.shake {
  animation: shake-anim 0.4s ease;
}

@keyframes shake-anim {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
  75% { transform: translateX(6px); }
}
</style>
