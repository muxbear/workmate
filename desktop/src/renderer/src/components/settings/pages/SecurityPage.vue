﻿<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingToggle from '../SettingToggle.vue'
import { useRuntimeStore } from '@store/runtime'
import { useSettingsStore } from '@store/settings'
import type { RuntimeId } from '../../../../../preload/index.d'

const sandboxEnabled = ref(true)
const autoBackupEnabled = ref(true)
const backupLimit = ref('3000')
const deleteProtection = ref(true)
const approvalLimit = ref('50')
const runtimeStore = useRuntimeStore()
const settingsStore = useSettingsStore()
const runtimeEnabled = computed({
  get: () => settingsStore.runtimeEnabled,
  set: (val: boolean) => { void settingsStore.set('runtime.enabled', val) }
})

/** 轻量 toast（安装/卸载反馈） */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 3000)
}

/** 错误弹框（不自动关闭，需手动关闭） */
const errorDialog = ref<{ title: string; message: string } | null>(null)
function showError(title: string, message: string): void {
  errorDialog.value = { title, message }
}
function closeError(): void {
  errorDialog.value = null
}

/** 运行时名称映射 */
const runtimeNames: Record<string, string> = {
  python: 'Python',
  node: 'Node.js',
  git: 'Git Bash'
}

/** 格式化字节数 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/** 获取运行时进度文案 */
function progressText(id: string): string {
  const p = runtimeStore.progressMap[id]
  if (!p) return ''
  if (p.phase === 'downloading') {
    const pct = p.percent > 0 ? p.percent + '%' : ''
    const size = p.totalBytes > 0 ? `${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}` : ''
    return [pct, size].filter(Boolean).join(' · ')
  }
  if (p.phase === 'extracting') return '解压中…'
  if (p.phase === 'verifying') return '验证中…'
  return ''
}

/** 判断运行时是否正在安装 */
function isInstalling(id: string): boolean {
  return runtimeStore.isInstalling(id as RuntimeId)
}

/** 切换单个运行时开关 */
async function onRuntimeToggle(id: RuntimeId, enabled: boolean): Promise<void> {
  await runtimeStore.toggle(id, enabled)
}

/** 安装运行时 */
async function onInstall(id: RuntimeId): Promise<void> {
  try {
    await runtimeStore.install(id)
    showToast(`${runtimeNames[id] ?? id} 安装成功`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : '安装失败'
    showError(`${runtimeNames[id] ?? id} 安装失败`, msg)
    console.error(`[security] install ${id} failed:`, err)
  }
}

/** 卸载运行时 */
async function onUninstall(id: RuntimeId): Promise<void> {
  try {
    await runtimeStore.uninstall(id)
    showToast(`${runtimeNames[id] ?? id} 已卸载`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : '卸载失败'
    showError(`${runtimeNames[id] ?? id} 卸载失败`, msg)
    console.error(`[security] uninstall ${id} failed:`, err)
  }
}

onMounted(() => {
  void runtimeStore.load()
  runtimeStore.subscribeProgress()
})

const systemToolMode = ref('禁用')
const auditCleared = ref(false)

const auditRecords = [
  { text: '[网络访问] 网络访问已执行：https://www.ke-work.cn/docs/ke-work/', time: '2026/8/2 21:42:43' },
  { text: '[网络访问] 网络访问已执行：https://www.ke-work.cn/docs/ke-work/Overview', time: '2026/8/2 21:42:43' },
  { text: '[命令安全] 沙箱内执行命令：mkdir -p "D:/work/KeWorkSpace/.ke-work/memory" && ls', time: '2026/8/2 17:52:17' },
  { text: "[命令安全] 沙箱内执行命令：python.exe -c import zipfile, os src = r'D:/work/KeWorkSpace/frontend/dist'", time: '2026/8/2 17:52:05' },
]

const sandboxRows = [
  { title: '文件安全', desc: '为沙箱拦截后的文件路径配置白名单和黑名单', icon: 'folder' },
  { title: '命令安全', desc: '为命令前缀配置询问和放行名单', icon: 'keyboard' },
  { title: '网络安全', desc: '控制 URL 访问与沙箱网络域名规则', icon: 'globe' },
]

const dataRows = [
  { title: '安全网关', desc: '工作空间出入流量统一经过安全网关安全处理', icon: 'layers' },
  { title: '传输加密', desc: '本地与云端通信使用端到端加密通道', icon: 'lock' },
]

</script>

<template>
  <div class="s-page">
    <div class="s-top">
      <p class="s-top-desc">
        统一管理工作空间内的进程安全、数据安全与系统授权
      </p>
      <span class="s-pill">安全能力由本地运行时提供</span>
    </div>

    <div class="s-grid">
      <!-- 沙箱安全 -->
      <section class="s-panel">
        <div class="s-row s-row--start">
          <div class="s-panel-head">
            <svg
              class="s-head-icon"
              width="23"
              height="23"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
              />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <div>
              <h2 class="s-sec-title">
                沙箱安全
              </h2>
              <p class="s-desc s-desc--lg">
                AI 运行于隔离沙箱，并配置文件、命令、网络访问策略
              </p>
            </div>
          </div>
          <div class="s-panel-actions">
            <svg
              class="s-help-icon"
              width="21"
              height="21"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
              />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            <SettingToggle v-model="sandboxEnabled" />
          </div>
        </div>
        <div class="s-inner-list">
          <button
            v-for="row in sandboxRows"
            :key="row.title"
            class="s-inner-row"
          >
            <span class="s-inner-icon">
              <!-- 文件安全 -->
              <svg
                v-if="row.icon === 'folder'"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                />
              </svg>
              <!-- 命令安全 -->
              <svg
                v-else-if="row.icon === 'keyboard'"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect
                  width="20"
                  height="16"
                  x="2"
                  y="4"
                  rx="2"
                />
                <path d="M6 8h.01" />
                <path d="M10 8h.01" />
                <path d="M14 8h.01" />
                <path d="M18 8h.01" />
                <path d="M8 12h.01" />
                <path d="M12 12h.01" />
                <path d="M16 12h.01" />
                <path d="M7 16h10" />
              </svg>
              <!-- 网络安全 -->
              <svg
                v-else
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                />
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                <path d="M2 12h20" />
              </svg>
            </span>
            <span class="s-inner-text">
              <strong>{{ row.title }}</strong>
              <span>{{ row.desc }}</span>
            </span>
            <svg
              class="s-chevron"
              width="18"
              height="18"
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
        <div class="s-inner-box">
          <div class="s-row">
            <div class="s-inner-box-head">
              <svg
                class="s-inner-icon"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <div>
                <strong class="s-inner-box-title">自动备份</strong>
                <span class="s-inner-box-desc">每轮对话修改文件之前自动备份。</span>
              </div>
            </div>
            <div class="s-panel-actions">
              <svg
                class="s-help-icon"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
              <SettingToggle v-model="autoBackupEnabled" />
            </div>
          </div>
          <div class="s-backup-row">
            <span>备份总上限</span>
            <input
              v-model="backupLimit"
              class="s-num-input"
            >
            <span>MB</span>
            <button class="s-dir-btn">
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                />
              </svg>
              打开备份目录
            </button>
          </div>
        </div>
      </section>

      <!-- 数据安全 -->
      <section class="s-panel">
        <div class="s-panel-head">
          <svg
            class="s-head-icon"
            width="23"
            height="23"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect
              width="18"
              height="11"
              x="3"
              y="11"
              rx="2"
              ry="2"
            />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <div>
            <h2 class="s-sec-title">
              数据安全
            </h2>
            <p class="s-desc s-desc--lg">
              数据流转及删除行为的安全防护
            </p>
          </div>
        </div>
        <div class="s-inner-list">
          <div
            v-for="row in dataRows"
            :key="row.title"
            class="s-inner-row s-inner-row--static"
          >
            <span class="s-inner-icon">
              <!-- 安全网关 -->
              <svg
                v-if="row.icon === 'layers'"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"
                />
                <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
                <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
              </svg>
              <!-- 传输加密 -->
              <svg
                v-else
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect
                  width="18"
                  height="11"
                  x="3"
                  y="11"
                  rx="2"
                  ry="2"
                />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <span class="s-inner-text">
              <strong>{{ row.title }}</strong>
              <span>{{ row.desc }}</span>
            </span>
            <span class="s-badge s-badge--status">已开启</span>
          </div>
          <div class="s-inner-row s-inner-row--static">
            <span class="s-inner-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
                />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            <span class="s-inner-text">
              <strong>删除保护</strong>
              <span>开启后优先移到废纸篓/回收站，关闭后按系统删除</span>
            </span>
            <SettingToggle v-model="deleteProtection" />
          </div>
          <div class="s-inner-row s-inner-row--static">
            <span class="s-inner-icon">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </span>
            <span class="s-inner-text">
              <strong>批量删除审批</strong>
              <span>需开启删除保护<br>一次删除达到该数量时需要审批</span>
            </span>
            <input
              v-model="approvalLimit"
              class="s-num-input s-num-input--sm"
            >
          </div>
        </div>
      </section>
    </div>

    <!-- 系统级工具 -->
    <section class="s-panel">
      <div class="s-row">
        <div class="s-panel-head">
          <svg
            class="s-head-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
            />
            <circle
              cx="12"
              cy="12"
              r="3"
            />
          </svg>
          <div>
            <h2 class="s-sec-title">
              系统级工具
            </h2>
            <p class="s-desc s-desc--lg">
              WSL、wmic、sc、reg、schtasks 等系统级工具可绕过沙箱限制，请谨慎启用
            </p>
          </div>
        </div>
        <div class="s-select-wrap">
          <select
            v-model="systemToolMode"
            class="s-select s-select--sm s-select--tool"
          >
            <option>禁用</option>
            <option>询问后启用</option>
            <option>始终启用</option>
          </select>
          <svg
            class="s-select-chevron"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>
    </section>

    <!-- 内置运行时 -->
    <section class="s-panel">
      <div class="s-row s-row--start">
        <div class="s-panel-head">
          <svg
            class="s-head-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div>
            <h2 class="s-sec-title">
              内置运行时
            </h2>
            <p class="s-desc s-desc--lg">
              允许使用随包提供的 Node.js、Python 和 Git Bash 工具
            </p>
          </div>
        </div>
        <SettingToggle v-model="runtimeEnabled" />
      </div>
      <div class="s-tool-head">
        <span>工具</span>
        <span>说明</span>
        <span>状态</span>
      </div>
      <div class="s-tool-list">
        <div
          v-for="tool in runtimeStore.runtimes"
          :key="tool.id"
          class="s-tool-row"
          :class="{ 's-tool-row--disabled': !runtimeEnabled }"
        >
          <div class="s-tool-name">
            <span
              class="s-tool-mark"
              :style="{ background: tool.color }"
            >{{ tool.mark }}</span>
            <div class="s-tool-name-text">
              <span>{{ tool.name }}</span>
              <span v-if="tool.version" class="s-tool-version">v{{ tool.version }}</span>
            </div>
          </div>
          <span class="s-tool-desc">{{ tool.description }}</span>
          <div class="s-tool-status">
            <!-- 安装中：进度条 + 百分比 + 禁用按钮 -->
            <template v-if="isInstalling(tool.id)">
              <div class="s-progress-wrap">
                <div class="s-progress-bar">
                  <div
                    class="s-progress-fill"
                    :style="{ width: (runtimeStore.progressMap[tool.id]?.percent ?? 0) + '%' }"
                  />
                </div>
                <span class="s-progress-text">{{ progressText(tool.id) }}</span>
              </div>
            </template>
            <!-- 已安装：徽章 + 卸载 + 开关 -->
            <template v-else-if="tool.status === 'installed'">
              <span class="s-status-badge s-status-badge--ok">已安装</span>
              <button
                class="s-action-btn"
                :disabled="!runtimeEnabled"
                @click="onUninstall(tool.id)"
              >卸载</button>
              <SettingToggle
                :model-value="tool.enabled"
                :disabled="!runtimeEnabled"
                @update:model-value="onRuntimeToggle(tool.id, $event)"
              />
            </template>
            <!-- 失败：徽章 + 重试 -->
            <template v-else-if="tool.status === 'error'">
              <span class="s-status-badge s-status-badge--err">失败</span>
              <button
                class="s-action-btn s-action-btn--primary"
                :disabled="!runtimeEnabled"
                @click="onInstall(tool.id)"
              >重试</button>
            </template>
            <!-- 未安装：徽章 + 安装 -->
            <template v-else>
              <span class="s-status-badge s-status-badge--muted">未安装</span>
              <button
                class="s-action-btn s-action-btn--primary"
                :disabled="!runtimeEnabled"
                @click="onInstall(tool.id)"
              >安装</button>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- 审计中心 -->
    <section class="s-panel">
      <div class="s-row s-row--start">
        <div class="s-panel-head">
          <svg
            class="s-head-icon"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <div>
            <h2 class="s-sec-title">
              审计中心
            </h2>
            <p class="s-desc s-desc--lg">
              拦截/放行记录与日志导出
            </p>
          </div>
        </div>
        <div class="s-audit-actions">
          <button class="s-audit-btn">
            导出日志
          </button>
          <button
            class="s-audit-btn"
            @click="auditCleared = true"
          >
            清空记录
          </button>
        </div>
      </div>
      <div class="s-audit-list">
        <p
          v-if="auditCleared"
          class="s-audit-empty"
        >
          暂无审计记录
        </p>
        <template v-else>
          <div
            v-for="(item, index) in auditRecords"
            :key="index"
            class="s-audit-row"
          >
            <span class="s-audit-text">{{ item.text }}</span>
            <span class="s-audit-time">{{ item.time }}</span>
          </div>
          <button class="s-audit-more">
            查看全部（还有 78 条）
            <svg
              width="18"
              height="18"
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
        </template>
      </div>
    </section>
    <!-- 错误弹框（不自动关闭） -->
    <Transition name="s-modal">
      <div v-if="errorDialog" class="s-error-overlay" @click.self="closeError">
        <div class="s-error-modal">
          <div class="s-error-modal-head">
            <svg
              class="s-error-icon"
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span class="s-error-title">{{ errorDialog.title }}</span>
          </div>
          <p class="s-error-message">{{ errorDialog.message }}</p>
          <div class="s-error-actions">
            <button class="s-error-close-btn" @click="closeError">知道了</button>
          </div>
        </div>
      </div>
    </Transition>
    <!-- 安装/卸载成功 toast -->
    <Transition name="s-toast">
      <div v-if="toast" class="s-rt-toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.s-page {
  max-width: 1060px;
  padding-bottom: 40px;
}

.s-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 28px;
}

.s-top-desc {
  font-size: 14px;
  color: #5f676d;
}

.s-pill {
  flex-shrink: 0;
  border-radius: 999px;
  background: #f4f5f5;
  padding: 6px 12px;
  font-size: 13px;
  color: #59636b;
}

.s-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 1000px) {
  .s-grid {
    grid-template-columns: 1fr;
  }
}

.s-panel {
  border-radius: 16px;
  background: #fbfbfb;
  border: 1px solid #e5e8e9;
  padding: 16px;
}

.s-panel + .s-panel {
  margin-top: 16px;
}

.s-panel-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.s-head-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--kw-color-brand);
}

.s-desc--lg {
  margin-top: 4px;
  font-size: 14px;
  line-height: 1.5;
}

.s-panel-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.s-help-icon {
  color: var(--kw-color-brand);
}

.s-inner-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.s-inner-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  border: none;
  background: var(--kw-color-bg-muted);
  border-radius: 12px;
  padding: 12px 16px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.s-inner-row:hover {
  background: #eceff0;
}

.s-inner-row--static {
  cursor: default;
}

.s-inner-row--static:hover {
  background: var(--kw-color-bg-muted);
}

.s-inner-icon {
  display: inline-flex;
  flex-shrink: 0;
  color: #505a60;
}

.s-inner-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.s-inner-text strong {
  font-size: 15px;
  font-weight: 500;
  color: #20272b;
}

.s-inner-text span {
  font-size: 13px;
  color: #606970;
}

.s-chevron {
  flex-shrink: 0;
  color: #4c555a;
}

.s-inner-box {
  margin-top: 8px;
  border-radius: 12px;
  background: var(--kw-color-bg-muted);
  padding: 12px 16px;
}

.s-inner-box-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.s-inner-box-title {
  display: block;
  font-size: 15px;
  font-weight: 500;
  color: #20272b;
}

.s-inner-box-desc {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  color: #606970;
}

.s-backup-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 16px;
  font-size: 13px;
  color: #5a6369;
}

.s-num-input {
  width: 96px;
  height: 40px;
  border-radius: 12px;
  border: 1px solid #e0e4e5;
  background: var(--kw-color-surface);
  text-align: center;
  font-size: 13px;
  color: #2c3337;
  outline: none;
  font-family: inherit;
}

.s-num-input:focus {
  border-color: var(--kw-color-brand);
}

.s-num-input--sm {
  width: 64px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
}

.s-dir-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #e0e4e5;
  background: var(--kw-color-surface);
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 13px;
  color: #31383c;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.s-dir-btn:hover {
  background: var(--kw-color-bg-soft);
}

.s-badge--status {
  border-radius: 999px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 13px;
  font-weight: 500;
  padding: 4px 10px;
  flex-shrink: 0;
}

.s-select--tool {
  min-width: 150px;
}

.s-tool-head {
  display: grid;
  grid-template-columns: 180px 1fr 160px;
  padding: 0 12px 12px;
  font-size: 13px;
  color: #697278;
}

.s-tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.s-tool-row {
  display: grid;
  grid-template-columns: 180px 1fr 160px;
  align-items: center;
  border-radius: 12px;
  background: #f2f3f4;
  padding: 12px 16px;
}

.s-tool-name {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 15px;
  font-weight: 600;
  color: #22282c;
}

.s-tool-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--kw-color-on-accent);
  font-size: 9px;
  font-weight: 700;
  flex-shrink: 0;
}

.s-tool-desc {
  padding-right: 16px;
  font-size: 13px;
  color: #59636b;
}

.s-tool-name-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.s-tool-version {
  font-size: 11px;
  font-weight: 400;
  color: #8a9298;
}

.s-tool-status {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}

.s-status-badge {
  font-size: 12px;
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.s-status-badge--ok {
  background: #e8f5e9;
  color: #2e7d32;
}

.s-status-badge--err {
  background: #fbe9e7;
  color: #c62828;
}

.s-status-badge--muted {
  background: #f0f0f0;
  color: #757575;
}

.s-status-loading {
  font-size: 13px;
  color: #757575;
}

.s-action-btn {
  border: 1px solid #e0e4e5;
  background: var(--kw-color-surface);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 13px;
  color: #31383c;
  cursor: pointer;
  transition: background-color 0.15s ease;
  flex-shrink: 0;
}

.s-action-btn:hover:not(:disabled) {
  background: var(--kw-color-bg-soft);
}

.s-action-btn--primary {
  border-color: var(--kw-color-brand);
  color: var(--kw-color-brand);
}

.s-action-btn--primary:hover:not(:disabled) {
  background: var(--kw-color-brand-soft);
}

.s-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.s-tool-row--disabled {
  opacity: 0.6;
}

.s-audit-actions {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.s-audit-btn {
  border: 1px solid #e0e4e5;
  background: var(--kw-color-surface);
  border-radius: 999px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: #30373b;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.s-audit-btn:hover {
  background: var(--kw-color-bg-soft);
}

.s-audit-list {
  margin-top: 16px;
  border-radius: 12px;
  background: #eff1f2;
  padding: 8px;
}

.s-audit-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  border-radius: 8px;
  background: var(--kw-color-surface);
  padding: 10px 12px;
  margin-bottom: 8px;
  font-size: 13px;
}

.s-audit-row:last-child {
  margin-bottom: 0;
}

.s-audit-text {
  line-height: 1.5;
  color: #1f2b34;
}

.s-audit-time {
  flex-shrink: 0;
  color: #53606a;
}

.s-audit-more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: none;
  background: var(--kw-color-surface);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #253039;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.s-audit-more:hover {
  background: var(--kw-color-bg-soft);
}

.s-audit-empty {
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: #7d868b;
}

.s-progress-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 140px;
}

.s-progress-bar {
  width: 120px;
  height: 6px;
  border-radius: 999px;
  background: #e0e4e5;
  overflow: hidden;
}

.s-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--kw-color-brand);
  transition: width 0.3s ease;
}

.s-progress-text {
  font-size: 11px;
  color: #757575;
  white-space: nowrap;
}
/* 安装/卸载反馈 toast */
.s-rt-toast {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  background: #2c3337;
  color: #fff;
  padding: 10px 20px;
  border-radius: 999px;
  font-size: 14px;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.s-toast-enter-active,
.s-toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.s-toast-enter-from,
.s-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* 错误弹框 */
.s-error-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.s-error-modal {
  width: 420px;
  max-width: 90vw;
  background: #fff;
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15);
}

.s-error-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.s-error-icon {
  color: #e53935;
  flex-shrink: 0;
}

.s-error-title {
  font-size: 16px;
  font-weight: 600;
  color: #1a1f23;
}

.s-error-message {
  font-size: 14px;
  line-height: 1.6;
  color: #5f676d;
  margin: 0 0 20px 0;
  word-break: break-word;
  white-space: pre-wrap;
}

.s-error-actions {
  display: flex;
  justify-content: flex-end;
}

.s-error-close-btn {
  border: none;
  border-radius: 999px;
  padding: 8px 24px;
  font-size: 14px;
  font-weight: 500;
  color: #fff;
  background: var(--kw-color-brand);
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.s-error-close-btn:hover {
  opacity: 0.85;
}

.s-modal-enter-active,
.s-modal-leave-active {
  transition: opacity 0.2s ease;
}

.s-modal-enter-from,
.s-modal-leave-to {
  opacity: 0;
}
</style>
