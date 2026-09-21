<script setup lang="ts">
import { ref } from 'vue'
import ChatMain from './ChatMain.vue'
import RightPanel from './RightPanel.vue'
import { usePanelResize } from '@/composables/usePanelResize'
import { useUiStore } from '@/stores/ui'

/** 对话页骨架：左侧对话区 + 可拖拽分割线 + 右侧工作区（历史对话 / 文档标签页） */
const uiStore = useUiStore()
const shellRef = ref<HTMLElement | null>(null)
const { dragging, onPointerDown, onKeyDown } = usePanelResize(shellRef)
</script>

<template>
  <div ref="shellRef" class="app-shell" :class="{ 'is-resizing': dragging }">
    <div class="chat-column">
      <ChatMain />
    </div>

    <!-- 对话区与右栏之间的分割线：按住左右拖动即可改变两边宽度 -->
    <div
      v-if="!uiStore.rightPanelCollapsed"
      class="panel-splitter"
      :class="{ 'is-dragging': dragging }"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整对话区与右栏宽度"
      title="拖动调整宽度，双击还原默认"
      tabindex="0"
      @pointerdown="onPointerDown"
      @keydown="onKeyDown"
      @dblclick="uiStore.resetRightPanelWidth()"
    >
      <span class="splitter-grip" />
    </div>

    <RightPanel />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  background: var(--surface-primary);
}

.chat-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.panel-splitter {
  position: relative;
  flex: 0 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: col-resize;
  background: transparent;
  outline: none;
}

.panel-splitter::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--border-subtle);
  transition:
    width var(--transition-duration) ease,
    background var(--transition-duration) ease;
}

.panel-splitter:hover::before,
.panel-splitter.is-dragging::before,
.panel-splitter:focus-visible::before {
  width: 2px;
  background: var(--accent-primary);
}

.splitter-grip {
  position: relative;
  width: 4px;
  height: 32px;
  border-radius: var(--radius-full);
  background: transparent;
  transition: background var(--transition-duration) ease;
}

.panel-splitter:hover .splitter-grip,
.panel-splitter.is-dragging .splitter-grip,
.panel-splitter:focus-visible .splitter-grip {
  background: var(--accent-primary);
}

/* 拖拽过程中关闭右栏宽度过渡，避免跟手延迟 */
.app-shell.is-resizing .right-panel {
  transition: none;
}
</style>
