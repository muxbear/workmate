<script setup lang="ts">
/**
 * 知识库页右侧的问答区。
 *
 * 标签行最左边是折叠/展开按钮，其后是**不可关闭的「问答」首标签**与若干可关闭的
 * 文档预览标签；标签放不下时右侧出现左右移动箭头。交互与对话页的右栏（RightPanel）
 * 保持一致，但状态落在 kbQa store 里——两个页面的面板宽度互不影响。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ChevronLeft, ChevronRight, Maximize, MessageSquare, Minimize,
  PanelRightClose, PanelRightOpen, X,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { KB_QA_COLLAPSED_WIDTH, QA_TAB_KEY, useKbQaStore } from '@/stores/kbQa'
import KbQaTab from './KbQaTab.vue'
import KbDocPreview from './KbDocPreview.vue'

const store = useKbQaStore()
const { t } = useI18n()

const tabsViewportRef = ref<HTMLElement | null>(null)
const overflow = ref(false)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
/** 两个标签移动按钮占用的宽度（按钮 26px + 间距 4px） */
const ARROW_SPACE = 60

const panelWidth = computed(() =>
  store.collapsed ? KB_QA_COLLAPSED_WIDTH : store.panelWidth,
)
/** 全屏态下由 flex 撑满主体宽度，不再写死像素宽度 */
const panelStyle = computed(() =>
  store.fullscreen
    ? {}
    : { width: panelWidth.value + 'px', minWidth: panelWidth.value + 'px' },
)

const activeDocTab = computed(() => store.currentDocTab())

let viewportObserver: ResizeObserver | null = null

/** 监听标签可视区尺寸：面板拖拽 / 窗口缩放导致标签放不下时，及时出现移动按钮 */
function bindViewportObserver() {
  viewportObserver?.disconnect()
  viewportObserver = null
  const el = tabsViewportRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  viewportObserver = new ResizeObserver(() => syncOverflow())
  viewportObserver.observe(el)
}

onMounted(() => {
  window.addEventListener('resize', syncOverflow)
  bindViewportObserver()
  void nextTick(syncOverflow)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncOverflow)
  viewportObserver?.disconnect()
  viewportObserver = null
})

watch(
  () => store.docTabs.map((tab) => tab.key).join('|'),
  () => void nextTick(syncOverflow),
)
watch(
  () => store.activeKey,
  () => void nextTick(scrollActiveTabIntoView),
)
watch(
  () => [store.panelWidth, store.collapsed],
  () =>
    void nextTick(() => {
      bindViewportObserver()
      syncOverflow()
    }),
)

/** 标签页总宽度超出可视区域时出现左右移动按钮 */
function syncOverflow() {
  const el = tabsViewportRef.value
  if (!el) {
    overflow.value = false
    canScrollLeft.value = false
    canScrollRight.value = false
    return
  }
  // 移动按钮显示后本身会占用宽度，这里把它补回来判断，
  // 保证「放得下就隐藏、放不下才显示」不会因为按钮自身宽度来回抖动
  const available = el.clientWidth + (overflow.value ? ARROW_SPACE : 0)
  overflow.value = el.scrollWidth - available > 1
  const maxScroll = el.scrollWidth - el.clientWidth
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft < maxScroll - 1
}

function scrollTabs(direction: 1 | -1) {
  const el = tabsViewportRef.value
  if (!el) return
  // 可选调用：jsdom 不实现 scrollBy，而这里不值得为此在调用点上加环境判断
  el.scrollBy?.({ left: direction * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' })
}

/** 激活的标签页滚动到可视区域 */
function scrollActiveTabIntoView() {
  const el = tabsViewportRef.value?.querySelector<HTMLElement>('.panel-tab.is-active')
  el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  syncOverflow()
}
</script>

<template>
  <aside
    class="qa-panel"
    :class="{ collapsed: store.collapsed, fullscreen: store.fullscreen }"
    :style="panelStyle"
  >
    <!-- 收起态：仅保留展开按钮 -->
    <div v-if="store.collapsed" class="qa-collapsed">
      <button
        class="panel-icon-btn"
        :title="t('knowledge.qa.expand')"
        :aria-label="t('knowledge.qa.expand')"
        @click="store.toggleCollapsed()"
      >
        <PanelRightOpen :size="14" />
      </button>
    </div>

    <div v-else class="qa-expanded">
      <div class="qa-bar">
        <!-- 折叠按钮：标签行的最左侧 -->
        <button
          class="panel-icon-btn"
          :title="t('knowledge.qa.collapse')"
          :aria-label="t('knowledge.qa.collapse')"
          @click="store.toggleCollapsed()"
        >
          <PanelRightClose :size="14" />
        </button>

        <div ref="tabsViewportRef" class="tabs-viewport" @scroll="syncOverflow">
          <!-- 标签用 role=tab 的 div 而不是 <button>：关闭按钮要能键盘操作，
               而按钮里不能再嵌按钮。两者配合 tabindex/aria-selected 保持可访问 -->
          <div class="tabs-track" role="tablist">
            <div
              class="panel-tab panel-tab--fixed"
              :class="{ 'is-active': store.activeKey === QA_TAB_KEY }"
              role="tab"
              tabindex="0"
              :aria-selected="store.activeKey === QA_TAB_KEY"
              @click="store.activateTab(QA_TAB_KEY)"
              @keydown.enter="store.activateTab(QA_TAB_KEY)"
              @keydown.space.prevent="store.activateTab(QA_TAB_KEY)"
            >
              <MessageSquare :size="13" />
              <span class="tab-label">{{ t('knowledge.qa.tabQa') }}</span>
            </div>
            <div
              v-for="tab in store.docTabs"
              :key="tab.key"
              class="panel-tab panel-tab--document"
              :class="{ 'is-active': store.activeKey === tab.key }"
              role="tab"
              tabindex="0"
              :aria-selected="store.activeKey === tab.key"
              :title="tab.title"
              @click="store.activateTab(tab.key)"
              @keydown.enter="store.activateTab(tab.key)"
              @keydown.space.prevent="store.activateTab(tab.key)"
            >
              <span class="tab-label">{{ tab.title }}</span>
              <button
                type="button"
                class="tab-close"
                :title="t('knowledge.qa.tabClose')"
                :aria-label="t('knowledge.qa.tabClose')"
                @click.stop="store.closeTab(tab.key)"
              >
                <X :size="12" />
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="overflow"
          class="panel-icon-btn tab-scroll"
          :title="t('knowledge.qa.tabScrollLeft')"
          :disabled="!canScrollLeft"
          :aria-label="t('knowledge.qa.tabScrollLeft')"
          @click="scrollTabs(-1)"
        >
          <ChevronLeft :size="14" />
        </button>
        <button
          v-if="overflow"
          class="panel-icon-btn tab-scroll"
          :title="t('knowledge.qa.tabScrollRight')"
          :disabled="!canScrollRight"
          :aria-label="t('knowledge.qa.tabScrollRight')"
          @click="scrollTabs(1)"
        >
          <ChevronRight :size="14" />
        </button>

        <!-- 全屏 / 还原：全屏时问答区占满主体宽度，知识库内容区让位 -->
        <button
          class="panel-icon-btn fullscreen-btn"
          :class="{ 'is-active': store.fullscreen }"
          :title="store.fullscreen ? t('knowledge.qa.exitFullscreen') : t('knowledge.qa.fullscreen')"
          :aria-pressed="store.fullscreen"
          :aria-label="store.fullscreen ? t('knowledge.qa.exitFullscreen') : t('knowledge.qa.fullscreen')"
          @click="store.toggleFullscreen()"
        >
          <Minimize v-if="store.fullscreen" :size="14" />
          <Maximize v-else :size="14" />
        </button>
      </div>

      <div class="qa-body">
        <!-- 问答标签用 v-show：切到预览标签再切回来时，会话与滚动位置都还在 -->
        <KbQaTab v-show="!activeDocTab" />
        <!-- 文档标签页看的是**原文**（按类型渲染），切片详情在它内部切换 -->
        <KbDocPreview
          v-if="activeDocTab"
          :key="activeDocTab.key"
          :doc="activeDocTab.doc"
          :kb-id="activeDocTab.kbId"
        />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.qa-panel {
  flex: 0 0 auto;
  height: 100%;
  background: var(--surface-card);
  border-left: 1px solid var(--border-subtle);
  overflow: hidden;
  transition:
    width var(--transition-duration) ease,
    min-width var(--transition-duration) ease;
}

/* 全屏态：由 flex 撑满主体宽度（此时知识库内容区已隐藏） */
.qa-panel.fullscreen {
  flex: 1;
  min-width: 0;
}

.qa-expanded {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 12px;
}

.qa-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-shrink: 0;
}

.panel-icon-btn {
  flex: 0 0 auto;
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

.panel-icon-btn:hover:not(:disabled) {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.panel-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tabs-viewport {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.tabs-viewport::-webkit-scrollbar {
  display: none;
}

.tabs-track {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.panel-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 68px;
  max-width: 160px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-sm);
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.panel-tab:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
}

.panel-tab:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.panel-tab.is-active {
  background: var(--accent-primary-light);
  color: var(--accent-primary);
  font-weight: var(--font-weight-semibold);
}

/* 「问答」固定标签不参与收窄 */
.panel-tab--fixed {
  flex: 0 0 auto;
  min-width: 0;
}

.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
}

.tab-close:hover {
  background: var(--surface-secondary);
  opacity: 1;
}

.qa-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 全屏态按钮高亮，提示再次点击可还原 */
.fullscreen-btn.is-active {
  background: var(--accent-primary-light);
  color: var(--accent-primary);
}

.qa-collapsed {
  height: 100%;
  position: relative;
}

.qa-collapsed .panel-icon-btn {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-secondary);
}
</style>
