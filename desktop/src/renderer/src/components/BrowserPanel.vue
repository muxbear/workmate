<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ fullscreen?: boolean }>()

const hostRef = ref<HTMLElement | null>(null)
const address = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)
const isLoading = ref(false)
const error = ref('')

let offState: (() => void) | null = null
let offError: (() => void) | null = null
let observer: ResizeObserver | null = null
let rafId = 0

function syncBounds(): void {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    const el = hostRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const zoom = window.api.getZoomFactor() || 1
    void window.api.browserSetBounds({
      x: rect.x * zoom,
      y: rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom
    })
  })
}

function resolveExternalUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw
  const looksLikeUrl =
    /^localhost(:\d+)?(\/|$)/i.test(raw) ||
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(raw)
  if (looksLikeUrl) return `https://${raw}`
  return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`
}

async function navigateExternal(raw: string): Promise<void> {
  const url = resolveExternalUrl(raw)
  error.value = ''
  const result = await window.api.browserNavigate(url)
  if (!result.success) throw new Error(result.error || '加载失败')
}

async function openWorkspaceFile(workspaceId: string, relPath: string): Promise<void> {
  error.value = ''
  const result = await window.api.browserOpenWorkspaceFile(workspaceId, relPath)
  if (!result.success || !result.data) throw new Error(result.error || '打开失败')
  address.value = result.data.displayUrl
}

async function go(): Promise<void> {
  const raw = address.value.trim()
  if (!raw) return

  if (raw.startsWith('workspace://')) {
    try {
      const url = new URL(raw)
      const workspaceId = url.host
      const relPath = decodeURIComponent(url.pathname.replace(/^\//, ''))
      await openWorkspaceFile(workspaceId, relPath)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '工作空间地址格式错误'
    }
    return
  }

  try {
    await navigateExternal(raw)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  }
}

async function back(): Promise<void> {
  error.value = ''
  const result = await window.api.browserBack()
  if (!result.success) error.value = result.error || '后退失败'
}

async function forward(): Promise<void> {
  error.value = ''
  const result = await window.api.browserForward()
  if (!result.success) error.value = result.error || '前进失败'
}

async function reload(): Promise<void> {
  error.value = ''
  const result = await window.api.browserReload()
  if (!result.success) error.value = result.error || '刷新失败'
}

async function openExternal(): Promise<void> {
  error.value = ''
  const result = await window.api.browserOpenExternal()
  if (!result.success) error.value = result.error || '外部打开失败'
}

onMounted(() => {
  observer = new ResizeObserver(syncBounds)
  if (hostRef.value) observer.observe(hostRef.value)
  window.addEventListener('resize', syncBounds)

  offState = window.api.onBrowserState((state) => {
    address.value = state.displayUrl || address.value
    canGoBack.value = state.canGoBack
    canGoForward.value = state.canGoForward
    isLoading.value = state.isLoading
  })
  offError = window.api.onBrowserLoadError((message) => {
    error.value = message
  })

  syncBounds()
})

watch(
  () => props.fullscreen,
  () => {
    void nextTick(syncBounds)
  }
)

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  observer?.disconnect()
  window.removeEventListener('resize', syncBounds)
  offState?.()
  offError?.()
})

defineExpose({ openWorkspaceFile })
</script>

<template>
  <div class="browser-panel">
    <div class="browser-toolbar">
      <button
        class="browser-btn"
        :disabled="!canGoBack"
        title="后退"
        aria-label="后退"
        @click="back"
      >
        ‹
      </button>
      <button
        class="browser-btn"
        :disabled="!canGoForward"
        title="前进"
        aria-label="前进"
        @click="forward"
      >
        ›
      </button>
      <button
        class="browser-btn"
        :disabled="isLoading"
        title="刷新"
        aria-label="刷新"
        @click="reload"
      >
        ⟳
      </button>
      <input
        v-model="address"
        class="browser-address"
        placeholder="输入网址，或输入 workspace:// 地址"
        spellcheck="false"
        @keydown.enter="go"
      />
      <button
        class="browser-btn"
        title="在外部浏览器打开"
        aria-label="在外部浏览器打开"
        @click="openExternal"
      >
        ↗
      </button>
    </div>

    <div v-if="error" class="browser-error">
      <span>{{ error }}</span>
      <button class="browser-retry" @click="go">重试</button>
    </div>

    <div ref="hostRef" class="browser-host"></div>
  </div>
</template>

<style scoped>
.browser-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.browser-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: rgba(8, 145, 178, 0.06);
  color: #0891b2;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.browser-btn:hover:not(:disabled) {
  background: rgba(8, 145, 178, 0.14);
  color: #0e7490;
}

.browser-btn:disabled {
  color: #cbd5e1;
  cursor: not-allowed;
  background: rgba(148, 163, 184, 0.08);
}

.browser-address {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(8, 145, 178, 0.18);
  border-radius: 8px;
  background: #ffffff;
  color: #334155;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.browser-address:focus {
  border-color: rgba(8, 145, 178, 0.5);
  box-shadow: 0 0 0 3px rgba(8, 145, 178, 0.08);
}

.browser-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  background: #fff1f2;
  border: 1px solid rgba(225, 29, 72, 0.16);
  color: #be123c;
  font-size: 12px;
  flex-shrink: 0;
}

.browser-retry {
  flex-shrink: 0;
  padding: 3px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(225, 29, 72, 0.08);
  color: #be123c;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.browser-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgba(8, 145, 178, 0.12);
  border-radius: 8px;
  background: #ffffff;
}
</style>
