<script setup lang="ts">
import { groupMenuItemsOf } from './knowledgeList'
import type { useKbGroups } from '@renderer/composables/useKbGroups'
import type { useKbLibraryOps } from '@renderer/composables/useKbLibraryOps'

/**
 * 知识库分组侧栏（R6：自 KnowledgePage 模板外提）。
 *
 * 概览入口 + 五个分组（展开/折叠、分组菜单、云分组状态提示）+ 组内条目行
 * （选中高亮、行内「接受/拒绝」邀请、条目三点菜单）。接口范式：注入组合件 API 对象；
 * 模式（含拖拽排序）不在本组件（见「查看更多」页）。
 */
const props = defineProps<{
  groups: ReturnType<typeof useKbGroups>
  libraryOps: ReturnType<typeof useKbLibraryOps>
  /** 侧栏宽度（useKbLayout 拖拽分栏结果） */
  groupsWidth: number
}>()

const emit = defineEmits<{ openOverview: [] }>()

const {
  knowledgeGroups,
  openGroupMenu,
  isGroupExpanded,
  toggleGroup,
  onGroupRowClick,
  toggleGroupMenu,
  openMoreGroup,
  refreshMoreGroupFrom,
  addKnowledgeLibrary,
  isActiveLibrary,
  onSidebarLibraryClick,
  cloudGroupHint,
  respondInvitation
} = props.groups

const { openLibMenu, openEditLibrary, openLibrarySettings, askDeleteLibrary } = props.libraryOps

/** 同一时刻只展开一个菜单：条目菜单与分组菜单互斥（页面原实现） */
const toggleLibMenu = (libraryId: string): void => {
  openLibMenu.value = openLibMenu.value === libraryId ? null : libraryId
  openGroupMenu.value = null
}
</script>

<template>
      <aside class="kb-groups" :style="{ width: `${groupsWidth}px` }">
        <button class="kb-overview" @click="emit('openOverview')">
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
            <rect width="7" height="9" x="3" y="3" rx="1" />
            <rect width="7" height="5" x="14" y="3" rx="1" />
            <rect width="7" height="9" x="14" y="12" rx="1" />
            <rect width="7" height="5" x="3" y="16" rx="1" />
          </svg>
          概览
        </button>

        <div class="kb-groups-list">
          <div
            v-for="group in knowledgeGroups"
            :key="group.id"
            class="kb-group"
            @mouseleave="openGroupMenu = null"
          >
            <div class="kb-group-head">
              <button class="kb-group-toggle" @click="onGroupRowClick(group)">
                <span class="kb-group-icon">
                  <svg
                    v-if="group.icon === 'hard-drive'"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="22" x2="2" y1="12" y2="12" />
                    <path
                      d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
                    />
                    <line x1="6" x2="6.01" y1="16" y2="16" />
                    <line x1="10" x2="10.01" y1="16" y2="16" />
                  </svg>
                  <svg
                    v-else-if="group.icon === 'users'"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <svg
                    v-else
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
                  </svg>
                </span>
                <span class="kb-group-label">{{ group.label }}</span>
              </button>

              <button
                class="kb-group-more"
                :title="`${group.label}操作`"
                @mouseenter="openGroupMenu = group.id"
                @click="toggleGroupMenu(group.id)"
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
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                  <circle cx="5" cy="12" r="1" />
                </svg>
              </button>

              <button
                class="kb-group-chevron"
                :class="{ 'kb-group-chevron--collapsed': !isGroupExpanded(group.id) }"
                :title="isGroupExpanded(group.id) ? '折叠' : '展开'"
                @click="toggleGroup(group.id)"
              >
                <svg
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
            </div>

            <!-- 分组操作菜单（悬浮时展开） -->
            <div
              v-if="openGroupMenu === group.id"
              class="kb-group-menu"
              @mouseenter="openGroupMenu = group.id"
            >
              <button class="kb-group-menu-item" @click="openMoreGroup(group.id)">
                <svg
                  width="13"
                  height="13"
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
                查看更多
              </button>
              <!-- 云分组只能刷新（云端建库涉及配置口径差异，本轮不做） -->
              <button
                v-if="groupMenuItemsOf(group).includes('refresh')"
                class="kb-group-menu-item"
                @click="refreshMoreGroupFrom(group)"
              >
                <svg
                  width="13"
                  height="13"
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
                刷新
              </button>
              <button
                v-if="groupMenuItemsOf(group).includes('create')"
                class="kb-group-menu-item"
                @click="addKnowledgeLibrary(group.id)"
              >
                <svg
                  width="13"
                  height="13"
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

            <!-- 分组下的知识库列表 -->
            <div v-if="isGroupExpanded(group.id)" class="kb-group-items">
              <div
                v-for="library in group.items"
                :key="`${group.id}:${library.cloud?.shareId ?? library.id}`"
                class="kb-lib-row"
                @mouseleave="openLibMenu = null"
              >
                <button
                  class="kb-lib-item"
                  :class="{ 'kb-lib-item--active': isActiveLibrary(library) }"
                  @click="onSidebarLibraryClick(library)"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                    />
                    <path d="M8 10v4" />
                    <path d="M12 10v2" />
                    <path d="M16 10v6" />
                  </svg>
                  <span class="kb-lib-name">{{ library.name }}</span>
                </button>

                <!-- 待接受的邀请：行内给接受/拒绝（与 Web 版侧栏一致） -->
                <span v-if="library.cloud?.shareStatus === 'pending'" class="kb-lib-actions">
                  <button type="button" @click.stop="respondInvitation(library, true)">接受</button>
                  <button type="button" @click.stop="respondInvitation(library, false)">
                    拒绝
                  </button>
                </span>

                <!-- 三点操作按钮：悬浮条目时淡入，点击展开菜单（云库没有本地编辑/删除操作） -->
                <button
                  v-if="library.source === 'local'"
                  class="kb-lib-more"
                  type="button"
                  :title="`「${library.name}」操作`"
                  :aria-label="`「${library.name}」操作`"
                  @click="toggleLibMenu(library.id)"
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
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                    <circle cx="5" cy="12" r="1" />
                  </svg>
                </button>

                <!-- 条目操作菜单：编辑 / 设置 / 删除 -->
                <div
                  v-if="openLibMenu === library.id && library.source === 'local'"
                  class="kb-lib-menu"
                >
                  <button class="kb-lib-menu-item" @click="openEditLibrary(library)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                      />
                      <path d="m15 5 4 4" />
                    </svg>
                    知识库编辑
                  </button>
                  <button class="kb-lib-menu-item" @click="openLibrarySettings(library)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path
                        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                      />
                    </svg>
                    知识库设置
                  </button>
                  <button
                    class="kb-lib-menu-item kb-lib-menu-item--danger"
                    @click="askDeleteLibrary(library)"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" x2="10" y1="11" y2="17" />
                      <line x1="14" x2="14" y1="11" y2="17" />
                    </svg>
                    知识库删除
                  </button>
                </div>
              </div>

              <!-- 空态 / 未授权 / 加载中：侧栏内联提示（失败不能只靠 1.8s 的 toast） -->
              <p
                v-if="
                  group.items.length === 0 && (cloudGroupHint(group) || group.source === 'local')
                "
                class="kb-group-hint"
              >
                <span>{{ cloudGroupHint(group)?.text ?? '暂无知识库，可从分组菜单新建' }}</span>
                <button
                  v-if="cloudGroupHint(group)?.action"
                  class="kb-group-hint-btn"
                  type="button"
                  @click="cloudGroupHint(group)?.run()"
                >
                  {{ cloudGroupHint(group)?.action }}
                </button>
              </p>
            </div>
          </div>
        </div>
      </aside>
</template>

<style scoped>
.kb-groups {
  width: 250px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 24px 12px;
  background: #f6f9f8;
  border-right: 1px solid #e2ebe7;
  scrollbar-width: none;
}
.kb-groups::-webkit-scrollbar {
  display: none;
}

.kb-overview {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 12px;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  background: #e5f3ef;
  color: #147967;
  border: none;
  font-family: inherit;
  cursor: pointer;
}

.kb-groups-list {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kb-group {
  position: relative;
}

.kb-group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding: 6px 8px;
}
.kb-group-head:hover {
  background: #edf4f1;
}

.kb-group-toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
}
.kb-group-icon {
  display: flex;
  color: #718087;
}
.kb-group-label {
  font-size: 12px;
  font-weight: 500;
  color: #425157;
}

.kb-group-more {
  display: flex;
  border-radius: 4px;
  padding: 4px;
  color: #668078;
  background: transparent;
  border: none;
  opacity: 0;
  transition: opacity 0.15s;
  cursor: pointer;
}
.kb-group:hover .kb-group-more {
  opacity: 1;
}
.kb-group-more:hover {
  background: #ffffff;
  color: #168b7a;
}

.kb-group-chevron {
  display: flex;
  padding: 4px;
  color: #718087;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-group-chevron--collapsed {
  transform: rotate(-90deg);
}

.kb-group-menu {
  position: absolute;
  right: 20px;
  top: 36px;
  z-index: 30;
  width: 126px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}
.kb-group-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: #405258;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-group-menu-item:hover {
  background: #f1f7f4;
}

.kb-group-items {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 1px solid #dce8e4;
  padding-left: 8px;
}

/* 侧栏内的空态 / 未授权 / 失败提示（失败不能只靠 1.8s 的 toast） */
.kb-group-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 2px 0 4px;
  padding: 4px 6px;
  font-size: 12px;
  line-height: 1.5;
  color: #8a969a;
}

.kb-group-hint-btn,
.kb-lib-actions button {
  border: 1px solid #cfe3dd;
  background: #f4faf8;
  border-radius: 5px;
  padding: 1px 8px;
  font-size: 12px;
  color: #168b7a;
  cursor: pointer;
}

.kb-group-hint-btn:hover,
.kb-lib-actions button:hover {
  background: #e6f4f1;
}

/* 待接受的分享邀请：行内「接受 / 拒绝」 */
.kb-lib-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
  padding-right: 4px;
}

/* 条目行：选择按钮 + 悬浮出现的操作按钮（同级按钮，避免 button 嵌套） */
.kb-lib-row {
  position: relative;
  margin-bottom: 2px;
  min-width: 0;
}

.kb-lib-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  /* 右侧给操作按钮预留：名称可用宽度恒定，悬浮时不重排 */
  padding: 6px 28px 6px 10px;
  text-align: left;
  font-family: inherit;
  background: transparent;
  color: #66757b;
  border: none;
  cursor: pointer;
}
.kb-lib-item:hover {
  background: #edf4f1;
}
/* 选中态必须与 :hover 同列写：否则 .kb-lib-item:hover 特异性更高会把选中色盖掉 */
.kb-lib-item--active,
.kb-lib-item--active:hover {
  background: #ddf0ea;
  color: #147967;
}
.kb-lib-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 三点操作按钮（悬浮淡入，对齐 .kb-group-more） */
.kb-lib-more {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  padding: 3px;
  border-radius: 4px;
  color: #668078;
  background: transparent;
  border: none;
  opacity: 0;
  transition: opacity 0.15s;
  cursor: pointer;
}
.kb-lib-row:hover .kb-lib-more,
.kb-lib-more:focus-visible {
  opacity: 1;
}
.kb-lib-more:hover {
  background: #ffffff;
  color: #168b7a;
}

/* 条目操作菜单（视觉对齐 .kb-group-menu） */
.kb-lib-menu {
  position: absolute;
  right: 4px;
  top: 28px;
  z-index: 30;
  width: 132px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}
.kb-lib-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: #405258;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-lib-menu-item:hover {
  background: #f1f7f4;
}
.kb-lib-menu-item--danger {
  color: #cf625b;
}
.kb-lib-menu-item--danger:hover {
  background: #fdeeee;
}
</style>
