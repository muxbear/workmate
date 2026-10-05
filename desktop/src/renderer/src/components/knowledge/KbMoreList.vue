<script setup lang="ts">
import type { useKbGroups } from '@renderer/composables/useKbGroups'

/**
 * 「查看更多」视图（R6：自 KnowledgePage 模板外提）。
 *
 * 面包屑 + 头部（标题/描述 + 刷新/视图切换/新建）+ 知识库列表（卡片与表格同一份
 * 数据、按 `viewMode` 渲染）+ 空态（云端区分「未授权/同步失败/真的为空」）。
 * 接口范式：注入组合件 API 对象（useKbGroups 返回值）；视图模式属页面偏好
 * （localStorage 持久化留在页面），切换经事件交回。
 *
 * 根上保留 `v-if="moreGroup"`：页面侧虽已有 v-if 保证「非空才挂载」，这里再收一次
 * 让模板内的 `moreGroup.label` / `cloudGroupHint(moreGroup)` 保持原有的类型收窄。
 */
const props = defineProps<{
  groups: ReturnType<typeof useKbGroups>
  /** 卡片 / 表格视图（页面持有并持久化） */
  viewMode: 'card' | 'table'
  /** 云分组「重新同步」按钮的禁用态（cloudKbStore.loading） */
  cloudLoading: boolean
}>()

const emit = defineEmits<{ toggleView: [] }>()

const {
  moreGroupId,
  moreGroup,
  cloudGroupHint,
  moreLibraries,
  isCloudMore,
  refreshMoreGroup,
  addKnowledgeLibrary,
  selectFromMore,
  draggingLibraryId,
  dropTargetId,
  dropAfterTarget,
  resetLibraryDrag,
  onLibraryDragStart,
  onLibraryDragOver,
  onLibraryDrop,
  toggleLibraryPin
} = props.groups
</script>

<template>
  <div v-if="moreGroup" class="kb-more">
    <div class="kb-more-inner">
      <div class="kb-breadcrumb">
        <button class="kb-breadcrumb-link" @click="moreGroupId = null">知识库</button>
        <svg
          class="kb-breadcrumb-sep"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>{{ moreGroup.label }}</span>
      </div>

      <div class="kb-more-header">
        <div>
          <p class="kb-more-eyebrow">Knowledge spaces</p>
          <h1 class="kb-more-title">{{ moreGroup.label }}</h1>
          <p class="kb-more-desc">
            {{
              isCloudMore
                ? '这些知识库来自云端账号，仅支持浏览与只读查看。'
                : '浏览、整理并调用这个分类下的全部知识库。'
            }}
          </p>
        </div>
        <div class="kb-more-actions">
          <!-- 云分组：重新拉取该 scope（本地分组没有"同步"这回事） -->
          <button
            v-if="isCloudMore"
            class="kb-more-view-toggle"
            type="button"
            title="重新同步云端知识库"
            aria-label="重新同步云端知识库"
            :disabled="cloudLoading"
            @click="refreshMoreGroup"
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
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <!-- 视图切换：一个图标按钮在卡片 / 表格之间切换（图标表示将切换到的视图） -->
          <button
            class="kb-more-view-toggle"
            type="button"
            :title="viewMode === 'card' ? '切换为表格视图' : '切换为卡片视图'"
            :aria-label="viewMode === 'card' ? '切换为表格视图' : '切换为卡片视图'"
            @click="emit('toggleView')"
          >
            <svg
              v-if="viewMode === 'card'"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M3 15h18" />
              <path d="M9 3v18" />
            </svg>
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
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
          </button>
          <button
            v-if="!isCloudMore"
            class="kb-more-create"
            @click="addKnowledgeLibrary(moreGroup?.id ?? 'local')"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            新建知识库
          </button>
        </div>
      </div>

      <div v-if="moreLibraries.length" class="kb-more-body">
        <!-- 卡片视图：整张卡片可拖拽排序，右上角置顶 -->
        <div v-if="viewMode === 'card'" class="kb-more-grid">
          <div
            v-for="library in moreLibraries"
            :key="library.id"
            class="kb-lib-card"
            :class="{
              'kb-lib-card--pinned': library.pinned === true,
              'kb-lib-card--dragging': draggingLibraryId === library.id,
              'kb-lib-card--drop-before': dropTargetId === library.id && !dropAfterTarget,
              'kb-lib-card--drop-after': dropTargetId === library.id && dropAfterTarget
            }"
            role="button"
            tabindex="0"
            :draggable="!isCloudMore"
            @click="selectFromMore(library)"
            @keydown.enter.prevent="selectFromMore(library)"
            @dragstart="onLibraryDragStart(library, $event)"
            @dragover="onLibraryDragOver(library, $event)"
            @drop.prevent="onLibraryDrop"
            @dragend="resetLibraryDrag"
          >
            <div class="kb-lib-card-head">
              <span
                class="kb-lib-card-badge"
                :style="{ color: library.tone, background: library.tone + '14' }"
              >
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
                  <path d="M12 7v14" />
                  <path
                    d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
                  />
                </svg>
              </span>
              <div class="kb-lib-card-ops">
                <span v-if="library.pinned === true" class="kb-pin-flag"> 置顶 </span>
                <button
                  v-if="!isCloudMore"
                  class="kb-pin-btn"
                  type="button"
                  :class="{ 'kb-pin-btn--on': library.pinned === true }"
                  :title="library.pinned === true ? '取消置顶' : '置顶'"
                  :aria-label="library.pinned === true ? '取消置顶' : '置顶'"
                  :aria-pressed="library.pinned === true"
                  @click.stop="toggleLibraryPin(library)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 17v5" />
                    <path
                      d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
                    />
                  </svg>
                </button>
                <span
                  v-if="!isCloudMore"
                  class="kb-drag-handle"
                  title="拖拽排序"
                  aria-hidden="true"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </span>
              </div>
            </div>
            <h2 class="kb-lib-card-title">{{ library.name }}</h2>
            <p class="kb-lib-card-desc">{{ library.description }}</p>
            <div class="kb-lib-card-foot">
              <span>{{ library.files }} 个文件</span>
              <span>更新于 {{ library.updated }}</span>
            </div>
          </div>
        </div>

        <!-- 表格视图：同样的拖拽 / 置顶能力，按行列对齐 -->
        <div v-else class="kb-more-table" role="table" aria-label="知识库列表">
          <div class="kb-more-table-head" role="row">
            <span class="kb-more-col kb-more-col--name" role="columnheader"> 名称 </span>
            <span class="kb-more-col kb-more-col--desc" role="columnheader"> 描述 </span>
            <span class="kb-more-col kb-more-col--files" role="columnheader"> 文件 </span>
            <span class="kb-more-col kb-more-col--time" role="columnheader"> 更新于 </span>
            <span class="kb-more-col kb-more-col--ops" role="columnheader"> 操作 </span>
          </div>
          <div
            v-for="library in moreLibraries"
            :key="library.id"
            class="kb-more-table-row"
            :class="{
              'kb-more-table-row--pinned': library.pinned === true,
              'kb-more-table-row--dragging': draggingLibraryId === library.id,
              'kb-more-table-row--drop-before': dropTargetId === library.id && !dropAfterTarget,
              'kb-more-table-row--drop-after': dropTargetId === library.id && dropAfterTarget
            }"
            role="row"
            tabindex="0"
            :draggable="!isCloudMore"
            @click="selectFromMore(library)"
            @keydown.enter.prevent="selectFromMore(library)"
            @dragstart="onLibraryDragStart(library, $event)"
            @dragover="onLibraryDragOver(library, $event)"
            @drop.prevent="onLibraryDrop"
            @dragend="resetLibraryDrag"
          >
            <span class="kb-more-col kb-more-col--name">
              <span class="kb-drag-handle" title="拖拽排序" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </span>
              <span class="kb-more-dot" :style="{ background: library.tone }" />
              <span class="kb-more-name">{{ library.name }}</span>
              <span v-if="library.pinned === true" class="kb-pin-flag"> 置顶 </span>
            </span>
            <span class="kb-more-col kb-more-col--desc">{{ library.description }}</span>
            <span class="kb-more-col kb-more-col--files">{{ library.files }}</span>
            <span class="kb-more-col kb-more-col--time">{{ library.updated }}</span>
            <span class="kb-more-col kb-more-col--ops">
              <button
                v-if="!isCloudMore"
                class="kb-pin-btn"
                type="button"
                :class="{ 'kb-pin-btn--on': library.pinned === true }"
                :title="library.pinned === true ? '取消置顶' : '置顶'"
                :aria-label="library.pinned === true ? '取消置顶' : '置顶'"
                :aria-pressed="library.pinned === true"
                @click.stop="toggleLibraryPin(library)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 17v5" />
                  <path
                    d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
                  />
                </svg>
              </button>
            </span>
          </div>
        </div>
      </div>

      <!-- 空态：云分组要区分「未授权 / 同步失败 / 真的为空」——失败只留 toast 会让人不知道怎么办 -->
      <div v-else class="kb-more-empty">
        <template v-if="isCloudMore">
          <p class="kb-more-empty-text">
            {{ cloudGroupHint(moreGroup)?.text ?? '暂无知识库' }}
          </p>
          <button
            v-if="cloudGroupHint(moreGroup)?.action"
            class="kb-more-empty-btn"
            type="button"
            @click="cloudGroupHint(moreGroup)?.run()"
          >
            {{ cloudGroupHint(moreGroup)?.action }}
          </button>
        </template>
        <template v-else>
          <p class="kb-more-empty-text">
            这个分类下还没有知识库，点右上角「新建知识库」创建。
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   查看更多：分组下的全部知识库
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-more {
  flex: 1;
  overflow-y: auto;
  background: #fbfcfc;
  padding: 32px;
  scrollbar-width: none;
}
.kb-more::-webkit-scrollbar {
  display: none;
}
.kb-more-inner {
  max-width: 1152px;
  margin: 0 auto;
}
.kb-breadcrumb {
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #7b8792;
}
.kb-breadcrumb-link {
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
}
.kb-breadcrumb-link:hover {
  color: #168b7a;
}
.kb-breadcrumb-sep {
  flex-shrink: 0;
}
.kb-more-header {
  margin-bottom: 28px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}
.kb-more-eyebrow {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #168b7a;
}
.kb-more-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #17252b;
}
.kb-more-desc {
  margin: 8px 0 0;
  font-size: 13px;
  color: #718087;
}
.kb-more-create {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 12px;
  background: #168b7a;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  color: #ffffff;
  border: none;
  cursor: pointer;
}
.kb-more-grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 16px;
}
@media (min-width: 768px) {
  .kb-more-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1280px) {
  .kb-more-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.kb-lib-card {
  position: relative;
  border-radius: 16px;
  border: 1px solid #e6eeeb;
  background: #ffffff;
  padding: 20px;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}
.kb-lib-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 30px rgba(18, 67, 61, 0.08);
}
.kb-lib-card-head {
  margin-bottom: 28px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.kb-lib-card-badge {
  display: flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}
.kb-lib-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #1d2c31;
}
.kb-lib-card-desc {
  margin: 6px 0 0;
  min-height: 40px;
  font-size: 12px;
  line-height: 20px;
  color: #77848a;
}
.kb-lib-card-foot {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
  border-top: 1px solid #eff3f1;
  padding-top: 12px;
  font-size: 11px;
  color: #8a969a;
}

/* 右上角操作区：视图切换（卡片 / 表格）+ 新建知识库 */
.kb-more-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.kb-more-view-toggle {
  display: flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid #e2ebe8;
  background: #ffffff;
  font-family: inherit;
  color: #5d6f72;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s,
    background 0.2s;
}
.kb-more-view-toggle:hover {
  border-color: #bfe0d8;
  background: #f2f9f7;
  color: #168b7a;
}

/* 卡片 / 表格共用的置顶按钮、置顶标记与拖拽手柄 */
.kb-pin-btn {
  display: flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #9aa7ab;
  cursor: pointer;
  transition:
    color 0.2s,
    background 0.2s;
}
.kb-pin-btn:hover {
  background: #eef7f4;
  color: #168b7a;
}
.kb-pin-btn--on {
  background: #e6f4f0;
  color: #168b7a;
}
.kb-pin-flag {
  border-radius: 999px;
  background: #e6f4f0;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  color: #168b7a;
}
.kb-drag-handle {
  display: flex;
  align-items: center;
  color: #b6c2c4;
  cursor: grab;
}
.kb-drag-handle:active {
  cursor: grabbing;
}

/* 卡片视图：置顶高亮 + 拖拽落点指示 */
.kb-lib-card-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-lib-card--pinned {
  border-color: #bfe0d8;
  background: #fbfefd;
}
.kb-lib-card--dragging {
  opacity: 0.45;
}
.kb-lib-card--drop-before::before,
.kb-lib-card--drop-after::after {
  position: absolute;
  top: 12px;
  bottom: 12px;
  width: 2px;
  border-radius: 2px;
  background: #168b7a;
  content: '';
}
.kb-lib-card--drop-before::before {
  left: -9px;
}
.kb-lib-card--drop-after::after {
  right: -9px;
}

/* 表格视图：与卡片视图同一份数据，按列展示 */
.kb-more-table {
  border-radius: 14px;
  border: 1px solid #e6eeeb;
  background: #ffffff;
  overflow: hidden;
}
.kb-more-table-head,
.kb-more-table-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.1fr) minmax(0, 1.6fr) 56px 96px 76px;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}
.kb-more-table-head {
  border-bottom: 1px solid #eef3f1;
  background: #f7faf9;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #8a969a;
}
.kb-more-table-row {
  position: relative;
  border-bottom: 1px solid #f1f5f3;
  font-size: 12px;
  color: #55636a;
  cursor: pointer;
}
.kb-more-table-row:last-child {
  border-bottom: none;
}
.kb-more-table-row:hover {
  background: #f7fbfa;
}
.kb-more-table-row--pinned {
  background: #fbfefd;
}
.kb-more-table-row--dragging {
  opacity: 0.45;
}
.kb-more-table-row--drop-before::before,
.kb-more-table-row--drop-after::after {
  position: absolute;
  left: 10px;
  right: 10px;
  height: 2px;
  border-radius: 2px;
  background: #168b7a;
  content: '';
}
.kb-more-table-row--drop-before::before {
  top: -1px;
}
.kb-more-table-row--drop-after::after {
  bottom: -1px;
}
.kb-more-col {
  min-width: 0;
}
.kb-more-col--name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #1d2c31;
}
.kb-more-col--desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-more-col--files,
.kb-more-col--time {
  font-size: 11px;
  color: #8a969a;
}
.kb-more-col--ops {
  display: flex;
  justify-content: flex-end;
}
.kb-more-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-more-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 999px;
}
.kb-more-empty {
  margin: 0;
  border-radius: 14px;
  border: 1px dashed #dbe6e3;
  padding: 28px;
  text-align: center;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #8a969a;
}

.kb-more-empty-text {
  margin: 0;
}

.kb-more-empty-btn {
  border: 1px solid #cfe3dd;
  background: #f4faf8;
  border-radius: 6px;
  padding: 5px 14px;
  font-size: 13px;
  color: #168b7a;
  cursor: pointer;
}

.kb-more-empty-btn:hover {
  background: #e6f4f1;
}
@media (max-width: 767px) {
  .kb-more-table-head,
  .kb-more-table-row {
    grid-template-columns: minmax(0, 1.4fr) 56px 96px 64px;
  }
  .kb-more-col--desc {
    display: none;
  }
}
</style>
