<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

/**
 * 通用模态壳（Template Method 的组件化形态）：
 * 遮罩 / 卡片 / 头部（标题 + 关闭 X）/ Escape 关闭 / 出入场过渡 固定在壳里，
 * 各模态只提供 头部内容、正文、底部按钮三个槽。
 *
 * 历史问题：11 个模态各自复制 mask/card/header/X/过渡（CSS 合计约 2300 行，
 * 关闭动画改一次要动 11 个文件）。z-index 统一 60（知识库模态族原值；
 * ConfirmDialog 由 50 升到 60，修正其被设置窗口壳（z 50）盖住的问题）。
 *
 * 关闭动画说明：组件保持挂载、visible 驱动 v-if（与知识库模态族现有模式一致）；
 * 以 `v-if` 由父级整体开关的场景（ConfirmDialog）没有离场动画，与改造前行为一致。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean
    /** 卡片宽度（CSS 值，支持 min() 等表达式）；默认 440px（知识库弹窗族口径） */
    width?: string
    /** 卡片最大高度（缺省 calc(100vh - 48px)；大模态可传自定义值保持原视觉） */
    maxHeight?: string
    /** 无障碍标签（role=dialog） */
    ariaLabel?: string
    /** 点遮罩是否关闭（默认 true） */
    closeOnMask?: boolean
    /** 底部区带上边框与纵向内边距（表格式/表单式底栏用；默认无边框紧凑款） */
    footerBordered?: boolean
    /** 遮罩层级（默认 60；需盖住下拉菜单/浮层(z150/200)或全局浮层时显式抬高） */
    zIndex?: number
  }>(),
  {
    width: '440px',
    maxHeight: '',
    ariaLabel: '对话框',
    closeOnMask: true,
    footerBordered: false,
    zIndex: 60
  }
)

const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- :duration 显式声明 200ms（与下方 CSS 过渡一致）：离场不移除依赖 transitionend ——
       窗口被最小化/遮挡时 Chromium 暂停渲染，transitionend 永不到达会致元素滞留 DOM -->
  <Transition
    name="ms-modal"
    :duration="200"
  >
    <div
      v-if="visible"
      class="ms-mask"
      :style="{ zIndex }"
      @click.self="closeOnMask && emit('close')"
    >
      <div
        class="ms-card"
        role="dialog"
        aria-modal="true"
        :aria-label="ariaLabel"
        :style="{ width, maxHeight: maxHeight || undefined }"
      >
        <header class="ms-header">
          <div class="ms-header-main">
            <slot name="header" />
          </div>
          <button class="ms-close" type="button" aria-label="关闭" @click="emit('close')">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <slot />
        <footer
          v-if="$slots.footer"
          :class="['ms-footer', { 'ms-footer--bordered': footerBordered }]"
        >
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ms-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.ms-card {
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-surface);
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
}

.ms-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--kw-color-border-brand);
}

.ms-header-main {
  flex: 1;
  min-width: 0;
}

.ms-close {
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
}

.ms-close:hover {
  color: var(--kw-color-text);
}

.ms-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 24px 20px;
}

.ms-footer--bordered {
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  border-top: 1px solid var(--kw-color-border-brand);
}

.ms-modal-enter-active,
.ms-modal-leave-active {
  transition: opacity 0.2s;
}

.ms-modal-enter-active .ms-card,
.ms-modal-leave-active .ms-card {
  transition: transform 0.2s;
}

.ms-modal-enter-from,
.ms-modal-leave-to {
  opacity: 0;
}

.ms-modal-enter-from .ms-card,
.ms-modal-leave-to .ms-card {
  transform: scale(0.92);
}
</style>
