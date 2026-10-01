<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Settings, X } from 'lucide-vue-next'
import BrandMark from '@/components/common/BrandMark.vue'
import SystemSettingsPanel from '@/components/settings/SystemSettingsPanel.vue'
import { useBrandStore } from '@/stores/brand'
import { useUiStore } from '@/stores/ui'

/**
 * 设置窗口。
 *
 * 与桌面版同形：带遮罩的弹出窗口，左栏导航 + 右侧内容，而不是独立路由页面。
 * 由 `MainLayout` 挂载、`TopBar` 的用户下拉打开——两者是兄弟节点，
 * 所以开关状态放在 ui store 里（与 `plusMenuOpen` 同一处）。
 *
 * 左栏目前只有「系统设置」一项——本次只实现它。桌面版其余 11 个子页
 * （账户管理 / 智能体设置 / 知识库设置 / …）不在本次范围，也不留占位。
 */
interface SettingsNavItem {
  key: 'system'
  label: string
  subtitle: string
  icon: typeof Settings
}

const NAV_ITEMS: SettingsNavItem[] = [
  {
    key: 'system',
    label: '系统设置',
    subtitle: '管理系统标识、显示语言、字号与通知偏好',
    icon: Settings,
  },
]

const uiStore = useUiStore()
const brandStore = useBrandStore()

const activeKey = ref<SettingsNavItem['key']>('system')

const activeItem = computed(
  () => NAV_ITEMS.find((item) => item.key === activeKey.value) ?? NAV_ITEMS[0],
)

function close() {
  uiStore.closeSettings()
}

/** 是否有正开着的 Element Plus 下拉（用于让位，见下） */
function hasOpenPopper(): boolean {
  return [...document.querySelectorAll('.el-select-dropdown')].some((el) => {
    const style = getComputedStyle(el)
    return style.display !== 'none' && el.getBoundingClientRect().height > 0
  })
}

/**
 * Esc 关闭。
 *
 * 用**捕获阶段**监听，因为 Element Plus 的 el-select 会把 Esc 吞掉——焦点落在它的
 * 输入框里时事件根本传不到 window，用户点过一次下拉之后就再也 Esc 不掉了。
 *
 * 代价是必须自己让位：有下拉开着时什么都不做，交给 EP 去关它，
 * 否则会变成「关下拉顺带把整个设置窗口也关了」。
 *
 * 窗口没开时直接返回，这样常驻的监听不会干扰页面上的其它浮层。
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !uiStore.settingsOpen) return
  if (hasOpenPopper()) return
  close()
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Transition name="settings">
    <div v-if="uiStore.settingsOpen" class="settings-mask" @click.self="close">
      <div class="settings-card" role="dialog" aria-modal="true" aria-label="设置">
        <aside class="settings-aside">
          <div class="settings-brand">
            <BrandMark :size="22" :src="brandStore.logoDisplaySrc" />
            <span class="settings-brand-text">{{ brandStore.systemName }}设置</span>
          </div>

          <nav class="settings-nav" aria-label="设置菜单">
            <button
              v-for="item in NAV_ITEMS"
              :key="item.key"
              type="button"
              class="settings-nav-item"
              :class="{ 'settings-nav-item--active': activeKey === item.key }"
              @click="activeKey = item.key"
            >
              <component :is="item.icon" :size="15" />
              <span>{{ item.label }}</span>
            </button>
          </nav>
        </aside>

        <div class="settings-main">
          <header class="settings-header">
            <div>
              <h2 class="settings-title">{{ activeItem.label }}</h2>
              <p class="settings-subtitle">{{ activeItem.subtitle }}</p>
            </div>
            <button type="button" class="settings-close" aria-label="关闭设置" @click="close">
              <X :size="18" />
            </button>
          </header>

          <div class="settings-content">
            <SystemSettingsPanel v-if="activeKey === 'system'" />
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.settings-mask {
  position: fixed;
  inset: 0;
  /* 压在应用框架（≤1000）之上，但低于 Element Plus 的浮层（从 2000 起）——
     否则面板里的 el-select 下拉和 ElMessage 提示会被遮罩盖住 */
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(4px);
}

.settings-card {
  display: flex;
  width: min(1040px, calc(100vw - 48px));
  height: min(820px, calc(100vh - 48px));
  overflow: hidden;
  background: var(--surface-primary);
  border: 1px solid var(--color-border-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
}

.settings-aside {
  width: 200px;
  flex-shrink: 0;
  padding: 12px 8px;
  overflow-y: auto;
  background: var(--surface-card);
  border-right: 1px solid var(--border-subtle);
}

.settings-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 12px;
}

.settings-brand-text {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-bold);
  color: var(--accent-primary);
  /* 系统名称长度不限（上限 24 字），窄侧栏里要能截断 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  text-align: left;
  /* --radius-md 在 variables.css 里没有定义，用它会静默回退成 0 */
  border-radius: var(--radius-lg);
  font-size: var(--font-size-base);
  color: var(--foreground-secondary);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.settings-nav-item:hover {
  background: var(--surface-secondary);
}

.settings-nav-item--active {
  background: rgba(59, 130, 246, 0.22);
  color: var(--foreground-primary);
}

.settings-nav-item--active :deep(svg) {
  color: var(--accent-primary);
}

.settings-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.settings-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.settings-subtitle {
  margin-top: 4px;
  font-size: var(--font-size-sm);
  color: var(--foreground-muted);
}

.settings-close {
  display: inline-flex;
  flex-shrink: 0;
  padding: 6px;
  border: none;
  background: none;
  border-radius: var(--radius-lg);
  color: var(--foreground-secondary);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.settings-close:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.settings-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 32px;
}

/* 遮罩淡入，卡片轻微放大——与桌面版的出场一致 */
.settings-enter-active,
.settings-leave-active {
  transition: opacity 0.18s ease;
}

.settings-enter-active .settings-card,
.settings-leave-active .settings-card {
  transition: transform 0.25s cubic-bezier(0.34, 1.4, 0.64, 1);
}

.settings-enter-from,
.settings-leave-to {
  opacity: 0;
}

.settings-enter-from .settings-card,
.settings-leave-to .settings-card {
  transform: scale(0.98) translateY(8px);
}
</style>
