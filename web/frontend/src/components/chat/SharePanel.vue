<script setup lang="ts">
import { computed, ref } from 'vue'
import { CheckSquare, Link2, QrCode, Square, X } from 'lucide-vue-next'
import qrcode from 'qrcode-generator'
import { useChatStore } from '@/stores/chat'

/** 分享面板（对齐桌面版「新建任务」分享：勾选消息 → 微信 / 朋友圈 / 链接 / 二维码 / 浏览器打开）。 */
const chatStore = useChatStore()

const qrOpen = ref(false)
const qrSvg = ref('')
const toast = ref('')

const total = computed(() => chatStore.messages.length)

function showToast(message: string) {
  toast.value = message
  setTimeout(() => (toast.value = ''), 2000)
}

async function copyText(text: string, tip: string) {
  try {
    await navigator.clipboard.writeText(text)
    showToast(tip)
  } catch {
    showToast('复制失败，请手动复制')
  }
}

function shareToWechat() {
  const text = chatStore.shareSelectedText()
  if (!text) {
    showToast('请先选择要分享的消息')
    return
  }
  void copyText(text, '已复制，请在微信中粘贴分享')
}

function shareToMoments() {
  const text = chatStore.shareSelectedText()
  if (!text) {
    showToast('请先选择要分享的消息')
    return
  }
  void copyText(text, '已复制，请在朋友圈中粘贴分享')
}

function copyShareLink() {
  void copyText(chatStore.shareLink(), '分享链接已复制')
}

function openShareInBrowser() {
  window.open(chatStore.shareLink(), '_blank', 'noopener')
}

function generateQr() {
  const link = chatStore.shareLink()
  const qr = qrcode(0, 'M')
  qr.addData(link)
  qr.make()
  qrSvg.value = qr.createSvgTag({ cellSize: 4, margin: 8 })
  qrOpen.value = true
}
</script>

<template>
  <div class="share-panel">
    <label class="share-all" @click.prevent="chatStore.toggleShareAll()">
      <CheckSquare v-if="chatStore.shareAllChecked" :size="14" />
      <Square v-else :size="14" />
      <span>全选 ({{ chatStore.shareSelected.length }}/{{ total }})</span>
    </label>
    <div class="share-divider" />
    <button class="share-action" @click="shareToWechat">分享到微信</button>
    <button class="share-action" @click="shareToMoments">分享到朋友圈</button>
    <button class="share-action" @click="copyShareLink">
      <Link2 :size="13" />
      <span>复制链接</span>
    </button>
    <button class="share-action" @click="generateQr">
      <QrCode :size="13" />
      <span>生成二维码</span>
    </button>
    <button class="share-action" @click="openShareInBrowser">浏览器打开</button>
    <div class="share-spacer" />
    <button class="share-close" title="关闭" @click="chatStore.closeSharePanel()">
      <X :size="14" />
    </button>
  </div>

  <div v-if="qrOpen" class="qr-mask" @click.self="qrOpen = false">
    <div class="qr-modal">
      <p class="qr-title">扫码打开分享链接</p>
      <div class="qr-body" v-html="qrSvg"></div>
      <p class="qr-link">{{ chatStore.shareLink() }}</p>
      <button class="qr-close" @click="qrOpen = false">关闭</button>
    </div>
  </div>

  <Transition name="fade">
    <div v-if="toast" class="share-toast">{{ toast }}</div>
  </Transition>
</template>
<style scoped>
.share-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 24px 8px;
  padding: 8px 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
}

.share-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.share-divider {
  width: 1px;
  height: 18px;
  background: var(--border-subtle);
}

.share-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.share-action:hover {
  background: var(--surface-secondary);
  color: var(--accent-primary);
}

.share-spacer {
  flex: 1;
}

.share-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.share-close:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.qr-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.4);
  z-index: 300;
}

.qr-modal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 24px 18px;
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
}

.qr-title {
  margin: 0;
  color: var(--foreground-primary);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}

.qr-body :deep(svg) {
  width: 200px;
  height: 200px;
}

.qr-link {
  margin: 0;
  max-width: 260px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
  word-break: break-all;
}

.qr-close {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.share-toast {
  position: fixed;
  left: 50%;
  bottom: 120px;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: var(--radius-lg);
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  font-size: var(--font-size-xs);
  z-index: 320;
  pointer-events: none;
  white-space: nowrap;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
