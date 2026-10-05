<script setup lang="ts">
/**
 * 分享对话框（R6：自 NewTaskPage 模板外提）——底部分享面板 + 二维码模态框。
 *
 * 纯展示组件：选中计数 / 全选三态 / 链接 / 二维码由父级传入（useSharePanel 组合件），
 * 交互经 emit 交回；面板是聊天列内的 flex 子项，二维码遮罩按既有 `absolute inset-0`
 * 定位（随组件挂在同一父容器内，锚定关系不变）。
 */
const props = defineProps<{
  /** 面板可见（分享选择模式） */
  visible: boolean
  /** 已选消息数 */
  selectedCount: number
  /** 消息总数 */
  total: number
  /** 全选态（含计数） */
  allChecked: boolean
  /** 半选态（部分选中） */
  allIndeterminate: boolean
  /** 二维码模态框可见 */
  qrVisible: boolean
  /** 二维码 dataURL（空串=生成中） */
  qrDataUrl: string
  /** 分享链接（二维码下方展示） */
  link: string
}>()

const emit = defineEmits<{
  toggleAll: []
  shareWechat: []
  shareMoments: []
  copyLink: []
  generateQr: []
  openBrowser: []
  close: []
  closeQr: []
}>()
</script>

<template>
  <Transition name="share-panel">
    <div v-if="props.visible" class="share-panel">
      <label class="share-select-all" @click.prevent="emit('toggleAll')">
        <input type="checkbox" :checked="props.allChecked" />
        <span
          class="share-select-all-box"
          :class="{ 'share-select-all-box--indeterminate': props.allIndeterminate }"
        >
          <svg
            v-if="props.allChecked"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span v-else-if="props.allIndeterminate" class="share-select-all-line"></span>
        </span>
        <span class="share-select-all-text"
          >全选 ({{ props.selectedCount }}/{{ props.total }})</span
        >
      </label>
      <div class="share-panel-divider"></div>
      <button class="share-action" title="分享到微信" @click="emit('shareWechat')">
        <span class="share-action-icon share-action-icon--wechat">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path
              d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
            />
          </svg>
        </span>
        <span class="share-action-text">分享到微信</span>
      </button>
      <button class="share-action" title="分享到朋友圈" @click="emit('shareMoments')">
        <span class="share-action-icon share-action-icon--moments">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
            <path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22" />
          </svg>
        </span>
        <span class="share-action-text">分享到朋友圈</span>
      </button>
      <button class="share-action" title="复制链接" @click="emit('copyLink')">
        <span class="share-action-icon share-action-icon--link">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </span>
        <span class="share-action-text">复制链接</span>
      </button>
      <button class="share-action" title="生成二维码" @click="emit('generateQr')">
        <span class="share-action-icon share-action-icon--qr">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM21 14v3M14 21h3" />
          </svg>
        </span>
        <span class="share-action-text">生成二维码</span>
      </button>
      <button class="share-action" title="浏览器打开" @click="emit('openBrowser')">
        <span class="share-action-icon share-action-icon--browser">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path
              d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
            />
          </svg>
        </span>
        <span class="share-action-text">浏览器打开</span>
      </button>
      <div class="share-panel-spacer"></div>
      <button class="share-close" title="关闭" @click="emit('close')">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </Transition>

  <!-- 分享二维码模态框 -->
  <Transition name="dropdown">
    <div v-if="props.qrVisible" class="qr-modal-mask" @click.self="emit('closeQr')">
      <div class="qr-modal">
        <button class="qr-modal-close" title="关闭" @click="emit('closeQr')">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <p class="qr-modal-title">扫码打开分享链接</p>
        <div class="qr-modal-body">
          <img v-if="props.qrDataUrl" :src="props.qrDataUrl" alt="分享二维码" class="qr-modal-img" />
          <div v-else class="qr-modal-loading">二维码生成中…</div>
        </div>
        <p class="qr-modal-link">{{ props.link }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   Share Panel（底部分享面板）
   ═══════════════════════════════════════════════════════════════════════════ */
.share-panel {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 760px;
  margin: 0 auto 12px;
  padding: 10px 14px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 14px;
  background: var(--kw-color-surface);
  box-shadow: 0 4px 20px rgba(15, 23, 42, 0.08);
  flex-shrink: 0;
}

.share-select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.share-select-all:hover {
  background: var(--kw-color-brand-hover);
}

.share-select-all input {
  display: none;
}

.share-select-all-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1.5px solid var(--kw-color-border-strong);
  background: var(--kw-color-surface);
  box-sizing: border-box;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.share-select-all-box--indeterminate {
  border-color: var(--kw-color-brand);
}

.share-select-all-line {
  width: 8px;
  height: 2px;
  border-radius: 1px;
  background: var(--kw-color-brand);
}

.share-select-all-text {
  font-size: 12px;
  color: var(--kw-color-text-secondary);
  white-space: nowrap;
}

.share-panel-divider {
  width: 1px;
  height: 20px;
  background: #e5e7eb;
  margin: 0 6px;
  flex-shrink: 0;
}

.share-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.share-action:hover {
  background: var(--kw-color-brand-soft);
}

.share-action-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--kw-color-on-accent);
}

.share-action-icon--wechat {
  background: #10b981;
}

.share-action-icon--moments {
  background: #059669;
}

.share-action-icon--link {
  background: var(--kw-color-brand);
}

.share-action-icon--qr {
  background: #7c3aed;
}

.share-action-icon--browser {
  background: #6366f1;
}

.share-action-text {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  white-space: nowrap;
}

.share-panel-spacer {
  flex: 1;
}

.share-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.share-close:hover {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
}

/* 分享面板过渡 */
.share-panel-enter-active,
.share-panel-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.share-panel-enter-from,
.share-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Share QR Modal（分享二维码模态框）
   ═══════════════════════════════════════════════════════════════════════════ */
.qr-modal-mask {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.qr-modal {
  position: relative;
  width: 300px;
  padding: 20px;
  border-radius: 16px;
  background: var(--kw-color-surface);
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.18);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-modal-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.qr-modal-close:hover {
  background: var(--kw-color-danger-soft);
  color: var(--kw-color-danger);
}

.qr-modal-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.qr-modal-body {
  width: 240px;
  height: 240px;
  border: 1px solid var(--kw-color-border);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.qr-modal-img {
  width: 240px;
  height: 240px;
  display: block;
}

.qr-modal-loading {
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.qr-modal-link {
  margin: 0;
  max-width: 260px;
  font-size: 11px;
  color: var(--kw-color-text-muted);
  word-break: break-all;
  text-align: center;
}

/* 二维码模态框进出场（与页面同名动效；scoped 样式对子组件内部 Transition 生效） */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
