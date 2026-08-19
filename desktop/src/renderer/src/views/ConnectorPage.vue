<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { connectorItems, useCatalogStore, type ConnectorItem } from '@store/catalog'

const catalog = useCatalogStore()
const search = ref('')

/** 连接器授权：在系统浏览器中打开该连接器的授权页面 */
const openConnectorAuth = (conn: ConnectorItem): void => {
  void window.api.openExternal(conn.authUrl)
}

/** 连接器聚焦：菜单点击「连接器」→ 定位并高亮对应授权连接卡片 */
const focusedConnectorId = ref<number | null>(null)
let focusTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => catalog.focusConnectorId,
  (id) => {
    if (focusTimer) {
      clearTimeout(focusTimer)
      focusTimer = null
    }
    if (id === null) return
    focusedConnectorId.value = id
    nextTick(() => {
      document
        .querySelector<HTMLElement>(`[data-connector-id="${id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    focusTimer = setTimeout(() => {
      focusedConnectorId.value = null
    }, 4000)
  },
  { immediate: true }
)
</script>

<template>
  <div class="connector-page">
    <div class="top-bar">
      <h1 class="page-title">连接器</h1>
      <div class="top-spacer"></div>
      <div class="search-box">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input v-model="search" type="text" placeholder="搜索连接器" class="search-input" />
      </div>
    </div>

    <div class="page-body">
      <div class="sec-intro">
        <h2 class="sec-title">连接器</h2>
        <p class="sec-desc">将外部服务接入KE-WORK，让 AI 直接读写你的数据与工具</p>
      </div>

      <div class="skill-grid">
        <div
          v-for="conn in connectorItems.filter(
            (c) => c.name.includes(search) || c.desc.includes(search)
          )"
          :key="conn.id"
          :data-connector-id="conn.id"
          class="skill-card"
          :class="{
            'skill-card--connected': conn.connected,
            'skill-card--focus': focusedConnectorId === conn.id
          }"
        >
          <div class="skill-icon" :style="{ background: conn.color }">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              stroke-width="2"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <div class="skill-info">
            <div class="skill-head">
              <div class="skill-head-left">
                <p class="skill-name">{{ conn.name }}</p>
                <span v-if="conn.connected" class="connected-badge"
                  ><span class="connected-dot"></span>已连接</span
                >
              </div>
              <button
                class="skill-install-btn"
                type="button"
                title="授权连接器"
                @click="openConnectorAuth(conn)"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
            <p class="skill-desc">{{ conn.desc }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.connector-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kw-color-surface);
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
}

.top-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 16px 24px 0;
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}

.page-title {
  margin: 0 16px 0 0;
  padding-bottom: 10px;
  color: var(--kw-color-text);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.top-spacer {
  flex: 1;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--kw-color-input-bg);
  border: 1px solid var(--kw-color-border-brand);
  color: var(--kw-color-text-faint);
}

.search-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  width: 128px;
}

.search-input::placeholder {
  color: var(--kw-color-text-faint);
}

.page-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  scrollbar-width: none;
}

.page-body::-webkit-scrollbar {
  display: none;
}

.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}

.sec-desc {
  font-size: 12px;
  color: var(--kw-color-text-muted);
  margin: 4px 0 0;
}

.sec-intro {
  margin-bottom: 16px;
}

.skill-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.skill-card {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.skill-card:hover {
  border-color: rgba(8, 145, 178, 0.28);
  background: var(--kw-color-surface);
}

.skill-card--connected {
  border-color: rgba(16, 185, 129, 0.25);
}

.skill-card--focus {
  border-color: var(--kw-color-brand);
  background: var(--kw-color-surface);
  box-shadow:
    0 0 0 3px rgba(8, 145, 178, 0.15),
    0 4px 12px rgba(8, 145, 178, 0.12);
}

.skill-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.skill-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}

.skill-desc {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  line-height: 1.4;
  margin: 0 0 12px;
}

.skill-install-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 8px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.skill-install-btn:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.skill-install-btn:active {
  transform: scale(0.92);
}

.connected-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
  font-size: 10px;
  font-weight: 500;
}

.connected-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
  display: inline-block;
}

@media (max-width: 1200px) {
  .skill-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .top-bar {
    padding: 12px 16px 0;
  }

  .page-body {
    padding: 16px;
  }

  .skill-grid {
    grid-template-columns: 1fr;
  }
}
</style>
