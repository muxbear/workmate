<script setup lang="ts">
import { nextTick, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'
import KnowledgeIndexPipeline from './KnowledgeIndexPipeline.vue'
import FilePreviewPane from '../file-preview/FilePreviewPane.vue'
import MessageContent from '../MessageContent.vue'
import type { FilePreviewSource } from '../file-preview/types'
import type { useKbQa } from '@renderer/composables/useKbQa'

/**
 * 问答 / 文件预览面板（R6：自 KnowledgePage 模板外提）。
 *
 * 标签栏（滚动/关闭/切换）+ 问答区（历史、流式回答、引用、输入与模型选择）+
 * 索引进度标签 + 文件预览标签 + 折叠条。接口范式：注入组合件 API 对象（useKbQa）
 * 与脊柱态（标签集合/当前标签/预览来源/布局开关由页面持有）；标签切换经
 * `update:activeTab` 事件交回页面（v-model 绑定）。
 */
const props = defineProps<{
  panelCollapsed: boolean
  panelFullscreen: boolean
  togglePanelCollapsed: () => void
  togglePanelFullscreen: () => void
  /** 标签栏滚动指示 { left, right }（useKbLayout） */
  tabScroll: { left: boolean; right: boolean }
  updateTabScroll: () => void
  moveTabs: (direction: -1 | 1) => void
  /** 打开的标签（'问答' 常驻；文件以 key 标识） */
  openTabs: string[]
  /** 当前标签（v-model:active-tab） */
  activeTab: string
  /** 标签显示名（文件重命名后跟随更新；留在页面因依赖活动树） */
  tabLabel: (tab: string) => string
  closeTab: (tab: string) => void
  /** 「索引进度」伪标签 key（页面常量） */
  indexTab: string
  /** 流水线标签指向的文档（组件按此从 store 实时取行） */
  pipelineTarget: { kbId: string; relPath: string } | null
  /** 文件预览来源（页面按活动标签派生） */
  previewSource: FilePreviewSource | null
  /** 问答组合件（useKbQa 返回值） */
  qa: ReturnType<typeof useKbQa>
  /** 当前库名（问答标题） */
  libraryName: string
  /** 多轮历史（知识库 store） */
  qaRounds: Array<{ question: string; answer: string }>
  clearQaHistory: () => void
  /** 页面持有的元素 ref（方盒传递：直接传 Ref 会被模板自动解包成值） */
  elementRefs: { tabBarRef: Ref<HTMLElement | null> }
}>()

const emit = defineEmits<{ 'update:activeTab': [tab: string] }>()

const {
  question,
  askState,
  ask,
  cancelAsk,
  openCitation,
  selectedKbId,
  qaModelName,
  qaModelMenuOpen,
  qaModelStore,
  qaModelLabel,
  pickQaModel
} = props.qa

/** 标签栏挂载/卸载时写回页面持有的元素 ref（useKbLayout 读取同一引用） */
const setTabBar = (el: Element | ComponentPublicInstance | null): void => {
  props.elementRefs.tabBarRef.value = el instanceof HTMLElement ? el : null
}

/**
 * 问答整列滚动（对齐 web KbQaTab）：横幅/历史/回答同一滚动区，
 * 新内容进来时贴住底部；输入区是滚动区的兄弟节点，始终固定在面板底部。
 */
const qaScrollRef = ref<HTMLElement | null>(null)
function scrollQaToBottom(): void {
  const el = qaScrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(
  () => props.qaRounds.length,
  () => void nextTick(scrollQaToBottom)
)
watch(
  () => askState.value?.answer,
  () => void nextTick(scrollQaToBottom)
)
</script>

<template>
  <aside v-if="!panelCollapsed" class="kb-panel">
    <div class="kb-tabs">
      <button
        class="kb-tab-scroll"
        :class="{ 'kb-tab-scroll--hidden': !tabScroll.left }"
        aria-label="向左滚动标签"
        @click="moveTabs(-1)"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>

      <div :ref="setTabBar" class="kb-tabbar" @scroll="updateTabScroll">
        <div
          v-for="tab in openTabs"
          :key="tab"
          class="kb-tab"
          :class="{ 'kb-tab--active': activeTab === tab }"
        >
          <button class="kb-tab-name" @click="emit('update:activeTab', tab)">{{ tabLabel(tab) }}</button>
          <button v-if="tab !== '问答'" class="kb-tab-close" @click="closeTab(tab)">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      <button
        class="kb-tab-scroll"
        :class="{ 'kb-tab-scroll--hidden': !tabScroll.right }"
        aria-label="向右滚动标签"
        @click="moveTabs(1)"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      <!-- 问答区域（最右侧）右上角：展开 / 折叠 + 全屏 / 还原（默认折叠） -->
      <div class="kb-panel-actions">
        <!-- 折叠：整个问答区域收起，用指向右侧的单箭头（与右栏「收起右栏」一致） -->
        <button
          class="kb-panel-btn kb-panel-btn--active"
          type="button"
          title="折叠"
          aria-label="折叠问答区域"
          :aria-expanded="true"
          @click="togglePanelCollapsed"
        >
          <svg
            width="16"
            height="16"
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
        <button
          class="kb-panel-btn"
          :class="{ 'kb-panel-btn--active': panelFullscreen }"
          type="button"
          :title="panelFullscreen ? '还原' : '全屏'"
          :aria-label="panelFullscreen ? '还原问答区域' : '全屏显示问答区域'"
          :aria-pressed="panelFullscreen"
          @click="togglePanelFullscreen"
        >
          <!-- 还原：四角向内（退出全屏） -->
          <svg
            v-if="panelFullscreen"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"
            />
          </svg>
          <!-- 全屏：四角向外 -->
          <svg
            v-else
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- 问答 -->
    <div v-if="activeTab === '问答'" class="kb-tab-content">
      <!-- 整列滚动区（对齐 web KbQaTab 的 .qa-main）：横幅/历史/回答同列滚动，输入区固定在底部 -->
      <div
        ref="qaScrollRef"
        class="kb-qa-scroll"
      >
        <div class="kb-qa-banner">
          <p class="kb-qa-eyebrow">KNOWLEDGE Q&amp;A</p>
          <h2 class="kb-qa-title">向 {{ libraryName }} 提问</h2>
          <p class="kb-qa-desc">
            基于本库已索引的内容作答；回答中的 [n] 对应下方「引用来源」，可点击定位到文件。
          </p>
        </div>

        <!-- 多轮历史：最近几轮已完成问答（换库/点「新对话」清空） -->
        <div v-if="qaRounds.length" class="kb-qa-history">
          <div class="kb-qa-history-head">
            <span>对话历史 · {{ qaRounds.length }} 轮</span>
            <button class="kb-qa-clear" @click="clearQaHistory()">新对话</button>
          </div>
          <div v-for="(round, index) in qaRounds" :key="index" class="kb-qa-round">
            <p class="kb-qa-round-q">{{ round.question }}</p>
            <p class="kb-qa-round-a">{{ round.answer }}</p>
          </div>
        </div>

        <div v-if="askState" class="kb-answer">
          <p v-if="askState.noRelevantResult" class="kb-answer-empty">
            知识库中没有找到与「{{ askState.question }}」相关的内容。
          </p>
          <template v-else>
            <!-- 回答走与聊天一致的 Markdown 管线（此前 `{{ }}` 纯文本：** 加粗/列表/代码块原样外露）；
                 相对图片按当前库只读解析（knowledgeId 透传） -->
            <div class="kb-answer-text">
              <MessageContent
                :content="askState.answer"
                :knowledge-id="selectedKbId || undefined"
                :breaks="true"
              />
              <span v-if="askState.streaming" class="kb-answer-caret"></span>
            </div>
            <p v-if="askState.canceled" class="kb-answer-note">已取消</p>
            <p v-if="askState.invalidCitations.length" class="kb-answer-note">
              回答中的
              {{ askState.invalidCitations.map((n) => `[${n}]`).join('、') }}
              未对应本次检索来源，请核对原文。
            </p>
            <p v-if="askState.error" class="kb-answer-error">{{ askState.error }}</p>
            <div v-if="askState.citations.length" class="kb-citations">
              <p class="kb-citations-title">引用来源</p>
              <button
                v-for="citation in askState.citations"
                :key="citation.index"
                class="kb-citation"
                @click="openCitation(citation)"
              >
                <span class="kb-citation-index">[{{ citation.index }}]</span>
                <span class="kb-citation-name">{{ citation.docName }}</span>
                <span class="kb-citation-path">
                  {{ citation.relPath }} › 切片 #{{ citation.chunkIndex + 1 }}
                  <template v-if="citation.heading"> › {{ citation.heading }}</template>
                </span>
              </button>
            </div>
          </template>
        </div>
      </div>

      <div class="kb-question-wrap">
        <div class="kb-qinput">
          <textarea
            v-model="question"
            rows="2"
            class="kb-qinput-textarea"
            placeholder="基于知识库提问"
            @keydown.enter.exact.prevent="ask"
          ></textarea>
          <div class="kb-qinput-foot">
            <div class="kb-model-wrap">
              <button class="kb-model-btn" @click="qaModelMenuOpen = !qaModelMenuOpen">
                {{ qaModelLabel }}
                <svg
                  class="kb-model-caret"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              <div v-if="qaModelMenuOpen" class="kb-model-menu">
                <button
                  class="kb-model-item"
                  :class="{ 'kb-model-item--active': !qaModelName }"
                  @click="pickQaModel('')"
                >
                  默认模型
                </button>
                <button
                  v-for="model in qaModelStore.models"
                  :key="model.id"
                  class="kb-model-item"
                  :class="{ 'kb-model-item--active': qaModelName === model.id }"
                  @click="pickQaModel(model.id)"
                >
                  {{ model.name }}
                </button>
              </div>
            </div>
            <div class="kb-qinput-actions">
              <button class="kb-icon-btn" title="添加附件">
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
                  <path d="M13.234 20.252 21 12.3" />
                  <path
                    d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"
                  />
                </svg>
              </button>
              <button class="kb-icon-btn" title="快捷剪裁">
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
                  <circle cx="6" cy="6" r="3" />
                  <path d="M8.12 8.12 12 12" />
                  <path d="M20 4 8.12 15.88" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M14.8 14.8 20 20" />
                </svg>
              </button>
              <button
                v-if="askState?.streaming"
                class="kb-send-btn kb-send-btn--stop"
                title="停止生成"
                @click="cancelAsk"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="none"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
              <button
                v-else
                class="kb-send-btn"
                title="发送问题"
                :disabled="!question.trim()"
                @click="ask"
              >
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
                    d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
                  />
                  <path d="m21.854 2.147-10.94 10.939" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 索引进度标签：7 阶段流水线，数据从 store 按 kbId+relPath 实时取 -->
    <div v-else-if="activeTab === indexTab" class="kb-tab-content kb-tab-content--pipe">
      <KnowledgeIndexPipeline
        v-if="pipelineTarget"
        :kb-id="pipelineTarget.kbId"
        :rel-path="pipelineTarget.relPath"
        @close="closeTab(indexTab)"
      />
    </div>

    <!-- 文件预览标签：只渲染文件内容本身（文件名/图标/元信息不在此处重复展示） -->
    <div v-else class="kb-file-tab">
      <FilePreviewPane v-if="previewSource" :source="previewSource" />
      <p v-else class="kb-preview-notice">在左侧文件列表中点击文件即可预览内容。</p>
    </div>
  </aside>
  <aside v-else class="kb-panel-strip">
    <button
      class="kb-panel-btn kb-panel-strip-btn"
      type="button"
      title="展开"
      aria-label="展开问答区域"
      :aria-expanded="false"
      @click="togglePanelCollapsed"
    >
      <!-- 展开：把问答区域从左拉出显示，用单箭头指向左侧 -->
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <span class="kb-panel-strip-label">问答</span>
  </aside>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   问答 / 文件预览面板（R6：自 KnowledgePage 外提，规则逐字迁移）
   ═══════════════════════════════════════════════════════════════════════════ */
/* ── 最右侧区域右上角：展开 / 折叠 / 全屏 ── */
.kb-panel-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  margin-left: 4px;
  border-left: 1px solid #e6eeeb;
  padding-left: 8px;
}
.kb-panel-btn {
  display: flex;
  padding: 5px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #8a969a;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.kb-panel-btn:hover {
  background: #edf4f1;
  color: #168b7a;
}
.kb-panel-btn--active {
  border-color: #cfe6df;
  background: #e5f3ef;
  color: #147967;
}

/* 收起后右侧只留一条展开入口，保证还能重新展开 */
.kb-panel-strip {
  display: flex;
  width: 44px;
  flex-shrink: 0;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  border-left: 1px solid #e6eeeb;
  background: #f7faf9;
  padding: 12px 0;
}
.kb-panel-strip-label {
  writing-mode: vertical-rl;
  font-size: 12px;
  letter-spacing: 0.18em;
  color: #879498;
}

/* ═══════════════════════════════════════════════════════════════════════════
   右侧：问答 / 文件预览面板
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-panel {
  min-width: 350px;
  flex: 1;
  overflow: hidden;
  background: #ffffff;
  display: flex;
  flex-direction: column;
}

/* ── 标签栏 ── */
.kb-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #e6eeeb;
  padding: 0 8px;
}
.kb-tab-scroll {
  display: flex;
  flex-shrink: 0;
  border-radius: 4px;
  padding: 4px;
  color: #718087;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s;
}
.kb-tab-scroll:hover {
  background: #edf4f1;
}
.kb-tab-scroll--hidden {
  pointer-events: none;
  opacity: 0;
}
.kb-tabbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-tabbar::-webkit-scrollbar {
  display: none;
}
.kb-tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  border-bottom: 2px solid transparent;
  padding: 12px;
  font-size: 12px;
  color: #758287;
}
.kb-tab--active {
  border-bottom-color: #168b7a;
  color: #147967;
}
.kb-tab-name {
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
}
.kb-tab-close {
  display: flex;
  border-radius: 4px;
  padding: 2px;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
}
.kb-tab-close:hover {
  background: #eff5f2;
}

/* ── 问答 ── */
.kb-tab-content {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding: 20px;
}
/* 索引进度面板：内容可能长于面板高度，允许滚动 */
.kb-tab-content--pipe {
  overflow-y: auto;
}
/* 问答整列滚动区（对齐 web KbQaTab 的 .qa-main）：横幅/历史/回答同列滚动；
   输入区（.kb-question-wrap）是它的兄弟节点，不随内容滚走 */
.kb-qa-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.kb-qa-banner {
  border-radius: 12px;
  border: 1px solid #d7ebe3;
  background: #edf7f3;
  padding: 16px;
}
.kb-qa-eyebrow {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: #168b7a;
}
.kb-qa-title {
  margin: 8px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #24433d;
}
.kb-qa-desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 20px;
  color: #55716a;
}
.kb-qa-history {
  margin-top: 16px;
  border-radius: 12px;
  background: #fbfdfc;
  border: 1px solid #e6efed;
  padding: 12px 14px;
}
.kb-qa-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #98a6a9;
  margin-bottom: 8px;
}
.kb-qa-clear {
  border: none;
  background: transparent;
  color: #16a394;
  font-size: 12px;
  cursor: pointer;
}
.kb-qa-round {
  padding: 8px 0;
  border-top: 1px dashed #e6efed;
}
.kb-qa-round:first-of-type {
  border-top: none;
}
.kb-qa-round-q {
  font-size: 12px;
  font-weight: 600;
  color: #42575a;
  margin-bottom: 4px;
}
.kb-qa-round-a {
  font-size: 12px;
  line-height: 20px;
  color: #6b7f83;
  white-space: pre-wrap;
  word-break: break-word;
}
.kb-answer {
  margin-top: 20px;
  border-radius: 12px;
  background: #f7faf9;
  padding: 16px;
  font-size: 12px;
  line-height: 24px;
  color: #42575a;
}
.kb-answer-text {
  word-break: break-word;
}

/* Markdown 渲染后段落间距收敛（面板窄，保持紧凑） */
.kb-answer-text :deep(.message-content > :first-child) {
  margin-top: 0;
}

.kb-answer-text :deep(.message-content > :last-child) {
  margin-bottom: 0;
}
.kb-answer-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: #16a394;
  animation: kb-caret-blink 1s steps(2, start) infinite;
}
@keyframes kb-caret-blink {
  to {
    visibility: hidden;
  }
}
.kb-answer-empty {
  color: #6b7f83;
}
.kb-answer-note {
  margin-top: 6px;
  color: #98a6a9;
}
.kb-answer-error {
  margin-top: 6px;
  color: #b45309;
}
.kb-citations {
  margin-top: 12px;
  border-top: 1px dashed #d6e2e0;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-citations-title {
  font-size: 12px;
  color: #98a6a9;
}
.kb-citation {
  display: flex;
  align-items: baseline;
  gap: 6px;
  text-align: left;
  border: 1px solid #dfe9e7;
  border-radius: 8px;
  background: #fff;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #42575a;
}
.kb-citation:hover {
  border-color: #16a394;
  background: #f2fbf9;
}
.kb-citation-index {
  flex-shrink: 0;
  color: #16a394;
  font-weight: 600;
}
.kb-citation-name {
  flex-shrink: 0;
  font-weight: 500;
}
.kb-citation-path {
  color: #98a6a9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-send-btn--stop {
  background: #b45309;
}
.kb-question-wrap {
  padding-top: 20px;
}

/* ── 提问输入框 ── */
.kb-qinput {
  border-radius: 24px;
  border: 1px solid #d9dfdd;
  background: #ffffff;
  padding: 12px;
  box-shadow: 0 1px 2px rgba(20, 44, 39, 0.03);
}
.kb-qinput:focus-within {
  border-color: #8dbfb3;
}
.kb-qinput-textarea {
  width: 100%;
  resize: none;
  background: transparent;
  border: none;
  padding: 2px 4px 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  color: #31454a;
  outline: none;
}
.kb-qinput-textarea::placeholder {
  color: #b7bec0;
}
.kb-qinput-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.kb-model-wrap {
  position: relative;
}
.kb-model-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 180px;
  max-height: 240px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #dfe9e7;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
  padding: 4px;
  z-index: 30;
  display: flex;
  flex-direction: column;
}
.kb-model-item {
  text-align: left;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: #42575a;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-model-item:hover {
  background: #f2fbf9;
}
.kb-model-item--active {
  color: #16a394;
  font-weight: 600;
}
.kb-model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 9999px;
  border: 1px solid #e1e6e4;
  background: #fbfcfc;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #4d5b60;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-model-btn:hover {
  background: #f0f6f3;
}
.kb-model-caret {
  color: #8a9598;
}
.kb-qinput-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-icon-btn {
  display: flex;
  border-radius: 8px;
  padding: 6px;
  color: #1d2b30;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-icon-btn:hover {
  background: #eef5f2;
}
.kb-send-btn {
  margin-left: 4px;
  display: flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-send-btn:disabled {
  background: #c8ccce;
  color: #ffffff;
  cursor: default;
}
.kb-send-btn:not(:disabled) {
  background: #168b7a;
  color: #ffffff;
}
.kb-send-btn:not(:disabled):hover {
  background: #117764;
}

/* ── 文件预览标签：容器不额外加装饰，内容占满整块区域 ── */
.kb-file-tab {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

/* ── 窄窗口兜底（原页面公共媒体查询中的面板部分） ── */
@media (max-width: 1699px) {
  /* 问答区改为随剩余空间收缩，不再撑破 .kb-detail 被裁切 */
  .kb-panel {
    min-width: 0;
  }
}
@media (max-width: 1199px) {
  /* 极窄下输入框底部按钮改为换行，避免撑出问答区 */
  .kb-qinput-foot {
    flex-wrap: wrap;
    gap: 6px;
  }
}
/* ═══════════════════════════════════════════════════════════════════════════
   文件预览（文本 / Markdown / 图片）
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-preview-notice {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--kw-color-text-muted);
}
</style>
