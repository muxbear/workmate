<script setup lang="ts">
/**
 * 知识库左栏——概览入口 + 四个栏目的树形列表。
 *
 * 交互对齐桌面版 KnowledgePage.vue 的分组侧栏：分组行默认只显示图标与名称，
 * 鼠标移入时右侧淡入「三点」与「折叠/展开」按钮；三点悬停弹出「查看更多」。
 */
import { computed } from 'vue'
import {
  ChevronDown, Database, FolderOpen, Globe, LayoutGrid, MoreVertical,
  Share2, User, Users,
} from 'lucide-vue-next'
import { useKnowledgeBaseStore, KB_GROUPS } from '@/stores/knowledgeBase'
import type { KbGroupDef } from '@/stores/knowledgeBase'
import type { KB, KBShare, KbScope } from '@/types/knowledgeBase'

const store = useKnowledgeBaseStore()
const emit = defineEmits<{
  (e: 'share-manage', kbId: string): void
  (e: 'cancel-share', kbId: string): void
}>()

const GROUP_ICONS: Record<string, typeof Database> = {
  public: Globe,
  personal: FolderOpen,
  sharedByMe: Share2,
  sharedWithMe: Users,
}

/** 「共享给我的」按知识库聚合：一个库可能同时有已接受与待接受的记录 */
interface WithMeEntry {
  kbId: string
  name: string
  accepted: boolean
  shareId: string
}

const sharedWithMeEntries = computed<WithMeEntry[]>(() =>
  store.invitations.map((i: KBShare) => ({
    kbId: i.kbId,
    name: i.kbName || i.kbId,
    accepted: i.status === 'accepted',
    shareId: i.id,
  })),
)

function groupItems(group: KbGroupDef): KB[] {
  return store.groupPreview(group.id)
}

function isActive(kbId: string): boolean {
  return store.selectedKb?.id === kbId
}

function isGroupActive(groupId: KbScope): boolean {
  return store.activeNav === groupId && !store.selectedKb
}

function selectKb(kb: KB) {
  store.setActiveNav('overview')
  void store.selectKb(kb.id)
}

function openOverview() {
  store.clearSelection()
  store.setActiveNav('overview')
  void store.fetchKbs()
}

function showMore(group: KbGroupDef) {
  store.clearSelection()
  store.setActiveNav(group.id)
}

function selectGroup(group: KbGroupDef) {
  store.toggleGroup(group.id)
}

async function respond(shareId: string, accept: boolean) {
  await store.respondInvitation(shareId, accept)
}
</script>

<template>
  <aside class="kb-sidebar">
    <!-- 概览入口 -->
    <button
      :class="['kb-overview', { active: store.activeNav === 'overview' && !store.selectedKb }]"
      @click="openOverview"
    >
      <LayoutGrid :size="15" />
      <span>知识库概览</span>
    </button>

    <div class="kb-groups-list">
      <div
        v-for="group in KB_GROUPS"
        :key="group.id"
        class="kb-group"
      >
        <!-- 分组头：名称 + 悬浮操作 -->
        <div class="kb-group-head" :class="{ active: isGroupActive(group.id) }">
          <button class="kb-group-label" @click="selectGroup(group)">
            <component :is="GROUP_ICONS[group.id]" :size="14" class="kb-group-icon" />
            <span class="kb-group-text">{{ group.label }}</span>
            <span
              v-if="group.id === 'sharedWithMe' && store.pendingInvitationCount"
              class="kb-badge"
              :title="`${store.pendingInvitationCount} 个待接受邀请`"
            >{{ store.pendingInvitationCount }}</span>
          </button>

          <el-dropdown trigger="hover" placement="bottom-end" @command="showMore(group)">
            <button class="kb-group-more" :title="`${group.label}操作`">
              <MoreVertical :size="15" />
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="more">查看更多</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <button
            class="kb-group-chevron"
            :class="{ 'is-collapsed': !store.groupExpanded[group.id] }"
            :title="store.groupExpanded[group.id] ? '折叠' : '展开'"
            @click="selectGroup(group)"
          >
            <ChevronDown :size="14" />
          </button>
        </div>

        <!-- 分组子项 -->
        <div v-if="store.groupExpanded[group.id]" class="kb-group-items">
          <!-- 共享给我的：按邀请记录渲染，待接受的给接受/拒绝按钮 -->
          <template v-if="group.id === 'sharedWithMe'">
            <div
              v-for="entry in sharedWithMeEntries"
              :key="entry.shareId"
              class="kb-lib-row"
            >
              <button
                class="kb-lib-item"
                :class="{ 'is-active': isActive(entry.kbId) }"
                @click="entry.accepted && store.selectKb(entry.kbId)"
              >
                <Database :size="13" />
                <span class="kb-lib-name">{{ entry.name }}</span>
              </button>
              <div v-if="!entry.accepted" class="kb-invite-actions">
                <button class="kb-mini-btn primary" @click.stop="respond(entry.shareId, true)">
                  接受
                </button>
                <button class="kb-mini-btn" @click.stop="respond(entry.shareId, false)">
                  拒绝
                </button>
              </div>
              <span v-else class="kb-lib-status" title="已接受">已接受</span>
            </div>
            <p v-if="!sharedWithMeEntries.length" class="kb-group-empty">暂无</p>
          </template>

          <!-- 其余分组：知识库列表 -->
          <template v-else>
            <div
              v-for="kb in groupItems(group)"
              :key="kb.id"
              class="kb-lib-row"
            >
              <button
                class="kb-lib-item"
                :class="{ 'is-active': isActive(kb.id) }"
                :title="kb.name"
                @click="selectKb(kb)"
              >
                <component :is="group.id === 'public' ? Globe : group.id === 'sharedByMe' ? Share2 : User" :size="13" />
                <span class="kb-lib-name">{{ kb.name }}</span>
              </button>

              <!-- 我的共享知识：管理该库的分享 -->
              <el-dropdown
                v-if="group.id === 'sharedByMe'"
                trigger="hover"
                placement="bottom-end"
                @command="(cmd: string) => cmd === 'manage'
                  ? emit('share-manage', kb.id)
                  : emit('cancel-share', kb.id)"
              >
                <button class="kb-lib-more" :title="`「${kb.name}」操作`">
                  <MoreVertical :size="15" />
                </button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="manage">查看已分享用户</el-dropdown-item>
                    <el-dropdown-item command="cancel">取消分享</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
            <p v-if="!groupItems(group).length" class="kb-group-empty">暂无</p>
          </template>

          <button
            v-if="group.id !== 'sharedWithMe' && store.groupHasMore(group.id)"
            class="kb-group-more-link"
            @click="showMore(group)"
          >
            查看更多（{{ store.groups[group.id]?.total }}）
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.kb-sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 12px 10px;
  overflow-y: auto;
  background: var(--surface-card);
  border-right: 1px solid var(--border-subtle);
}

/* 概览入口 */
.kb-overview {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.kb-overview:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.kb-overview.active {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(139, 92, 246, 0.18));
  border-color: rgba(59, 130, 246, 0.3);
  color: var(--foreground-primary);
}

.kb-groups-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kb-group {
  display: flex;
  flex-direction: column;
}

/* 分组头 */
.kb-group-head {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 6px 6px 10px;
  border-radius: var(--radius-lg);
  transition: background 0.15s;
}

.kb-group-head:hover {
  background: var(--surface-secondary);
}

.kb-group-head.active {
  background: rgba(59, 130, 246, 0.12);
}

.kb-group-label {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.kb-group-icon {
  flex-shrink: 0;
  color: var(--foreground-secondary);
}

.kb-group-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-badge {
  flex-shrink: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: rgba(244, 63, 94, 0.9);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

/* 三点 / 折叠按钮：默认隐藏，分组悬浮时淡入 */
.kb-group-more,
.kb-group-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.kb-group:hover .kb-group-more,
.kb-group:hover .kb-group-chevron,
.kb-group-more:focus-visible,
.kb-group-chevron:focus-visible {
  opacity: 1;
}

.kb-group-more:hover,
.kb-group-chevron:hover {
  background: var(--surface-card);
  color: var(--foreground-primary);
}

.kb-group-chevron {
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}

.kb-group-chevron.is-collapsed {
  transform: rotate(-90deg);
}

/* 子项 */
.kb-group-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 1px 0 4px 14px;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
}

.kb-lib-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
}

.kb-lib-row:hover {
  background: var(--surface-secondary);
}

.kb-lib-item {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 5px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.kb-lib-item:hover {
  color: var(--foreground-primary);
}

.kb-lib-item.is-active {
  background: rgba(59, 130, 246, 0.15);
  color: var(--foreground-primary);
}

.kb-lib-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-lib-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  margin-right: 2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.kb-lib-row:hover .kb-lib-more,
.kb-lib-more:focus-visible {
  opacity: 1;
}

.kb-lib-more:hover {
  background: var(--surface-card);
  color: var(--foreground-primary);
}

.kb-lib-status {
  flex-shrink: 0;
  margin-right: 4px;
  color: #6ee7b7;
  font-size: 10px;
}

.kb-invite-actions {
  display: flex;
  gap: 3px;
  margin-right: 3px;
}

.kb-mini-btn {
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.kb-mini-btn:hover {
  color: var(--foreground-primary);
  border-color: var(--border-medium);
}

.kb-mini-btn.primary {
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  border-color: transparent;
  color: #fff;
}

.kb-group-empty {
  margin: 2px 0;
  padding: 4px 6px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.kb-group-more-link {
  margin-top: 2px;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent-primary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

.kb-group-more-link:hover {
  background: var(--surface-secondary);
}
</style>
