<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import BrandMark from '@/components/common/BrandMark.vue'
import type { LocaleCode } from '@/locales'
import { extractErrorMessage } from '@/services/request'
import { useBrandStore } from '@/stores/brand'
import { useUiStore } from '@/stores/ui'
import type { NotificationSound } from '@/types/settings'
import {
  SYSTEM_NAME_MAX_LENGTH,
  buildSavePlan,
  logoPreviewSrc,
  showsResetLogo,
  validateSystemNameDraft,
  type LogoDraft,
} from '@/utils/brandIdentityDraft'
import { canUseDesktopNotification, requestDesktopPermission } from '@/utils/browserNotify'

/**
 * 「设置 → 系统设置」面板。
 *
 * 结构与桌面版 `SystemSettingsPage.vue` 对齐，但只保留 Web 端有意义的区块：
 * 桌面版的存储路径、网络代理、锁屏远程在浏览器里没有对应物。
 */
const brandStore = useBrandStore()
const uiStore = useUiStore()

const LOGO_MAX_BYTES = 1024 * 1024

/**
 * 语言下拉用自己的选项表而不是复用 `LOCALE_OPTIONS`：后者的「中文」标签
 * 被 TopBar 里那两个窄药丸按钮复用，换成「简体中文」会把它们撑破。
 */
const LANG_OPTIONS: { value: LocaleCode; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const SOUND_OPTIONS: { value: NotificationSound; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'crisp', label: '清脆' },
  { value: 'soft', label: '柔和' },
]

// ---- ① 系统标识：草稿式，点「保存」才提交 ----

const logoInputRef = ref<HTMLInputElement | null>(null)
const logoDraft = ref<LogoDraft>({ kind: 'keep' })
const nameDraft = ref(brandStore.systemName)
/** 用户是否动过名称输入框——动过之后就不能再用后端值覆盖他 */
const nameTouched = ref(false)
const saving = ref(false)
const logoError = ref('')
const nameError = ref('')

const logoPreview = computed(() => logoPreviewSrc(logoDraft.value, brandStore.logoDisplaySrc))
const canResetLogo = computed(() => showsResetLogo(logoDraft.value, brandStore.hasCustomLogo))

function setLogoDraft(next: LogoDraft) {
  // 换草稿时释放上一个 objectURL，否则每选一次图就漏一个 blob
  if (logoDraft.value.kind === 'file') URL.revokeObjectURL(logoDraft.value.url)
  logoDraft.value = next
}

function fillNameDraft() {
  nameDraft.value = brandStore.systemName
  nameTouched.value = false
}

// main.ts 的品牌拉取可能比本组件挂载晚，回来时要回填
watch(
  () => brandStore.loaded,
  (ready) => {
    if (ready && !nameTouched.value) fillNameDraft()
  },
)

onUnmounted(() => {
  if (logoDraft.value.kind === 'file') URL.revokeObjectURL(logoDraft.value.url)
})

function onPickLogo() {
  logoError.value = ''
  logoInputRef.value?.click()
}

function onResetLogo() {
  logoError.value = ''
  setLogoDraft({ kind: 'reset' })
}

function onLogoChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value，否则同一个文件第二次选中不会再触发 change
  input.value = ''
  if (!file) return
  if (file.size > LOGO_MAX_BYTES) {
    logoError.value = 'LOGO 大小不能超过 1MB'
    return
  }
  logoError.value = ''
  setLogoDraft({ kind: 'file', file, url: URL.createObjectURL(file) })
}

function onSystemNameInput() {
  nameTouched.value = true
  nameError.value = ''
}

function onSystemNameBlur() {
  // 清空后失焦就回到已保存值，避免留下「没有系统名称」的状态
  if (!nameDraft.value.trim()) fillNameDraft()
}

async function onSaveBrandIdentity() {
  if (saving.value) return
  const invalid = validateSystemNameDraft(nameDraft.value)
  if (invalid) {
    nameError.value = invalid
    return
  }
  nameError.value = ''
  logoError.value = ''

  const plan = buildSavePlan(
    logoDraft.value,
    nameDraft.value,
    brandStore.systemName,
    brandStore.hasCustomLogo,
  )
  if (plan.name === null && plan.logo === null) {
    ElMessage.info('系统标识已是最新，无需保存')
    return
  }

  saving.value = true
  try {
    // 先名称后 LOGO：名称便宜且更可能被校验拦下
    if (plan.name !== null) {
      try {
        await brandStore.saveSystemName(plan.name)
      } catch (error) {
        nameError.value = '系统名称保存失败：' + extractErrorMessage(error)
        return
      }
      // 立即脱脏，避免「看着还没保存」
      fillNameDraft()
    }

    try {
      if (plan.logo === 'upload' && logoDraft.value.kind === 'file') {
        await brandStore.uploadLogo(logoDraft.value.file)
      } else if (plan.logo === 'reset') {
        await brandStore.resetLogo()
      }
    } catch (error) {
      // 名称这时可能已经写进去了，提示里必须说清楚，否则用户不知道该不该重填
      logoError.value =
        (plan.name !== null ? '系统名称已保存；' : '') +
        'LOGO 保存失败：' +
        extractErrorMessage(error)
      return
    }

    setLogoDraft({ kind: 'keep' })
    fillNameDraft()
    ElMessage.success('系统标识已保存')
  } finally {
    saving.value = false
  }
}

// ---- ② 显示语言 / ③ 字体大小 ----

async function onLanguageChange(next: LocaleCode) {
  try {
    await uiStore.saveLanguage(next)
  } catch {
    ElMessage.error('语言保存失败')
  }
}

/** 拖动过程中只是跟手预览，不写服务端 */
function onFontSizeInput(next: number | number[]) {
  uiStore.setFontSize(Array.isArray(next) ? next[0] : next)
}

/**
 * 松手才提交。
 *
 * `@input` 是必需的：`el-slider` 在这里是**受控**的（`:model-value` 而非 `v-model`），
 * 不把新值写回 model 的话，组件会在 mouseup 前把内部值回退成 prop 值，
 * 于是 `change` 报出来的是改动**之前**的值——滑块看着在动，存下去的却始终是旧值。
 */
async function onFontSizeChange(next: number | number[]) {
  const value = Array.isArray(next) ? next[0] : next
  try {
    await uiStore.persistFontSize(value)
  } catch {
    ElMessage.error('字号保存失败')
  }
}

// ---- ④ 通知 ----

/**
 * 开启「客户端通知」。
 *
 * 拿不到权限时**保持关闭**并提示：桌面版这个开关的语义就是「转桌面通知」，
 * 在浏览器永远不会弹的情况下把 true 存进服务端，这个设置就是假的。
 * 因为模板用 `:model-value` 而不是 `v-model`，回滚是免费的。
 */
async function onClientNotificationsChange(next: unknown) {
  if (next !== true) {
    uiStore.setClientNotifications(false)
    return
  }
  if (!canUseDesktopNotification()) {
    ElMessage.warning('当前环境不支持浏览器通知（需要 HTTPS 或 localhost）')
    return
  }
  const permission = await requestDesktopPermission()
  if (permission !== 'granted') {
    ElMessage.warning(
      permission === 'denied' ? '浏览器已禁止通知，请在浏览器设置中允许后重试' : '未授予通知权限',
    )
    return
  }
  uiStore.setClientNotifications(true)
}

function onSoundChange(next: NotificationSound) {
  uiStore.setNotificationSound(next)
}
</script>

<template>
  <div class="s-page">
    <!-- ① 系统标识 -->
    <section class="s-card">
      <h2 class="s-sec-title">系统标识</h2>
      <p class="s-desc s-desc--mt">
        设置系统 LOGO 与系统名称；点「保存」后生效，站内所有展示系统名称的位置都会跟随此处设置。
      </p>
      <div class="s-hairline" />

      <div class="s-brand-row">
        <div class="s-brand-preview">
          <BrandMark :size="52" :src="logoPreview" />
        </div>
        <div class="s-brand-actions">
          <el-button :disabled="saving" @click="onPickLogo">选择图片</el-button>
          <el-button v-if="canResetLogo" :disabled="saving" @click="onResetLogo">
            恢复默认
          </el-button>
          <input
            ref="logoInputRef"
            class="s-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            @change="onLogoChange"
          />
        </div>
      </div>
      <p class="s-help">支持 PNG / JPG / WEBP / SVG，建议使用 1:1 正方形图片，大小不超过 1MB。</p>
      <p v-if="logoError" class="s-error">{{ logoError }}</p>

      <div class="s-brand-name">
        <span class="s-brand-name-label">系统名称</span>
        <input
          v-model="nameDraft"
          class="s-input"
          type="text"
          aria-label="系统名称"
          :maxlength="SYSTEM_NAME_MAX_LENGTH"
          placeholder="请输入系统名称"
          @input="onSystemNameInput"
          @blur="onSystemNameBlur"
        />
      </div>
      <p v-if="nameError" class="s-error">{{ nameError }}</p>

      <div class="s-brand-footer">
        <el-button type="primary" :disabled="saving" @click="onSaveBrandIdentity">
          {{ saving ? '保存中…' : '保存' }}
        </el-button>
      </div>
    </section>

    <!-- ② 显示语言 -->
    <section class="s-card">
      <div class="s-row">
        <div>
          <h2 class="s-sec-title">显示语言</h2>
          <p class="s-desc s-desc--mt">设置应用程序界面的显示语言。</p>
        </div>
        <el-select
          class="s-control"
          :model-value="uiStore.locale"
          aria-label="显示语言"
          @change="onLanguageChange"
        >
          <el-option
            v-for="opt in LANG_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
      </div>
    </section>

    <!-- ③ 字体大小 -->
    <section class="s-card">
      <h2 class="s-sec-title">字体大小</h2>
      <div class="s-hairline" />
      <el-slider
        class="s-slider"
        :model-value="uiStore.fontSize"
        :min="12"
        :max="24"
        :step="1"
        aria-label="字体大小"
        @input="onFontSizeInput"
        @change="onFontSizeChange"
      />
      <div class="s-range-labels">
        <span>小</span>
        <span>默认</span>
        <span>大</span>
      </div>
    </section>

    <!-- ④ 通知 -->
    <h2 class="s-group-title">通知</h2>

    <section class="s-card">
      <div class="s-row">
        <div>
          <h3 class="s-sec-title">客户端通知</h3>
          <p class="s-desc s-desc--mt">运营消息优先端内送达，位于后台时自动转桌面通知。</p>
        </div>
        <el-switch
          :model-value="uiStore.clientNotifications"
          aria-label="客户端通知"
          @change="onClientNotificationsChange"
        />
      </div>
    </section>

    <section class="s-card">
      <div class="s-row">
        <div>
          <h3 class="s-sec-title">提示音设置</h3>
          <p class="s-desc s-desc--mt">客户端通知时的提示音风格</p>
        </div>
        <el-select
          class="s-control"
          :model-value="uiStore.notificationSound"
          aria-label="提示音设置"
          @change="onSoundChange"
        >
          <el-option
            v-for="opt in SOUND_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
      </div>
    </section>
  </div>
</template>

<style scoped>
.s-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.s-card {
  /* 用 --surface-card 而不是 --surface-secondary：页面底色是 --surface-primary（浅灰），
     secondary 在它上面几乎没有对比，卡片会糊成一片 */
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 14px 16px;
}

.s-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.s-sec-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.s-desc {
  font-size: var(--font-size-base);
  color: var(--foreground-muted);
}

.s-desc--mt {
  margin-top: 4px;
}

.s-group-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  padding: 4px 4px 0;
}

.s-hairline {
  height: 1px;
  background: var(--border-subtle);
  margin: 12px 0;
}

/* ---- 系统标识 ---- */

.s-brand-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
}

.s-brand-preview {
  display: flex;
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px solid var(--border-medium);
  background: var(--surface-card);
  /* 自定义 LOGO 是图片，需要裁切才能跟随圆角 */
  overflow: hidden;
}

.s-brand-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.s-file-input {
  display: none;
}

.s-brand-name {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.s-brand-name-label {
  flex-shrink: 0;
  font-size: var(--font-size-md);
  color: var(--foreground-secondary);
}

.s-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-medium);
  background: var(--color-bg-input);
  padding: 0 12px;
  font-size: var(--font-size-base);
  color: var(--foreground-primary);
  outline: none;
}

.s-input:focus {
  border-color: var(--accent-primary);
}

.s-help {
  margin-top: 8px;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.s-error {
  margin-top: 8px;
  font-size: var(--font-size-sm);
  color: var(--el-color-danger);
}

.s-brand-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* ---- 字体大小 ---- */

.s-slider {
  margin-top: 4px;
}

.s-range-labels {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
}

/* ---- 控件 ---- */

.s-control {
  width: 160px;
  flex-shrink: 0;
}

/* 项目没有全局映射 Element Plus 主色，各组件就近覆盖 */
:deep(.el-switch.is-checked .el-switch__core) {
  background: var(--accent-primary) !important;
  border-color: var(--accent-primary) !important;
}

:deep(.el-slider__bar) {
  background: var(--accent-primary);
}

:deep(.el-slider__button) {
  border-color: var(--accent-primary);
}

:deep(.el-button--primary) {
  --el-button-bg-color: var(--accent-primary);
  --el-button-border-color: var(--accent-primary);
  --el-button-hover-bg-color: var(--accent-primary);
  --el-button-hover-border-color: var(--accent-primary);
  --el-button-active-bg-color: var(--accent-primary);
  --el-button-active-border-color: var(--accent-primary);
}
</style>
