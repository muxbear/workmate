<script setup lang="ts">
import {
  ChevronRight, ChevronDown, Plus, Edit2, Trash2,
  MessageSquare, Send, Database, Upload, LayoutGrid, Timer, Play,
  Bot, Cpu, Wrench, Zap, Puzzle, Shield, ShieldCheck, Users,
  UserPlus, Save, LayoutList, Folder, FolderTree, MousePointerClick,
  ScrollText,
} from 'lucide-vue-next'
import { PERM_TYPE_CONFIG, PERM_STATUS_CONFIG } from '@/types/admin'
import type { PermResource } from '@/types/admin'
import type { Component } from 'vue'
import { useMenuConfigStore } from '@/stores/menuConfig'
import { useTreeDrag } from '@/composables/useTreeDrag'

const props = defineProps<{
  resource: PermResource
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  childrenList: PermResource[]
}>()

const emit = defineEmits<{
  select: [id: string]
  toggleExpand: [id: string]
  addChild: [resource: PermResource]
  edit: [resource: PermResource]
  delete: [resource: PermResource]
}>()

const store = useMenuConfigStore()
const drag = useTreeDrag()

function handlePointerDown(event: PointerEvent) {
  drag.onPointerDown(event, props.resource)
}

function handlePointerMove(event: PointerEvent) {
  drag.onPointerMove(event)
}

function handlePointerUp(event: PointerEvent) {
  drag.onPointerUp(event)
}

function handlePointerCancel(event: PointerEvent) {
  drag.onPointerCancel(event)
}

function handleNodeClick() {
  drag.handleClick(() => emit('select', props.resource.id))
}

const iconMap: Record<string, Component> = {
  MessageSquare, Send, Database, Upload, LayoutGrid, Timer, Play,
  Bot, Cpu, Wrench, Zap, Puzzle, Shield, ShieldCheck, Users,
  UserPlus, Edit2, Save, LayoutList, Folder, FolderTree, MousePointerClick,
  Plus, Trash2, ScrollText,
}

function resolveIcon(name: string): Component {
  return iconMap[name] || Folder
}
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{
        active: selectedId === resource.id,
        dragging: store.draggingResourceId === resource.id,
        'drop-before': store.dropTargetId === resource.id && store.dropPlacement === 'before',
        'drop-after': store.dropTargetId === resource.id && store.dropPlacement === 'after',
        'drop-inside': store.dropTargetId === resource.id && store.dropPlacement === 'inside',
      }"
      :data-resource-id="resource.id"
      :style="{ paddingLeft: `${depth * 16 + 8}px` }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerCancel"
      @click="handleNodeClick"
    >
      <button
        class="expand-btn"
        :class="{ invisible: childrenList.length === 0 }"
        @pointerdown.stop
        @click.stop="emit('toggleExpand', resource.id)"
      >
        <ChevronDown v-if="expandedIds.has(resource.id)" :size="14" />
        <ChevronRight v-else :size="14" />
      </button>

      <div class="node-icon" :class="PERM_TYPE_CONFIG[resource.type].bg">
        <component :is="resolveIcon(resource.icon)" :size="14" :class="PERM_TYPE_CONFIG[resource.type].color" />
      </div>

      <div class="node-body">
        <div class="node-label-row">
          <span class="node-label">{{ resource.label }}</span>
          <span
            v-if="resource.status !== 'active'"
            class="status-badge"
            :class="PERM_STATUS_CONFIG[resource.status].color"
          >
            {{ PERM_STATUS_CONFIG[resource.status].label }}
          </span>
        </div>
        <div class="node-key">{{ resource.permKey }}</div>
      </div>

      <div class="node-actions" @pointerdown.stop>
        <button
          v-if="resource.type !== 'button'"
          class="action-btn"
          @click.stop="emit('addChild', resource)"
          title="添加子节点"
        >
          <Plus :size="14" />
        </button>
        <button class="action-btn" @click.stop="emit('edit', resource)" title="编辑">
          <Edit2 :size="14" />
        </button>
        <button class="action-btn danger" @click.stop="emit('delete', resource)" title="删除">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>

    <!-- 递归子节点 -->
    <template v-if="expandedIds.has(resource.id) && childrenList.length > 0">
      <MenuConfigTreeNode
        v-for="child in childrenList"
        :key="child.id"
        :resource="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        :expanded-ids="expandedIds"
        :children-list="[]"
        @select="emit('select', $event)"
        @toggle-expand="emit('toggleExpand', $event)"
        @add-child="emit('addChild', $event)"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
      />
    </template>
  </div>
</template>

<script lang="ts">
export default { name: 'MenuConfigTreeNode' }
</script>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  border: 1px solid transparent;
  user-select: none;
}
.tree-node:hover { background: rgba(59,130,246,0.06); }
.tree-node.active {
  background: rgba(59,130,246,0.12);
  border-color: rgba(59,130,246,0.25);
}
.tree-node.dragging { opacity: 0.45; }
.tree-node.drop-before { box-shadow: 0 -2px 0 0 var(--accent-primary); }
.tree-node.drop-after { box-shadow: 0 2px 0 0 var(--accent-primary); }
.tree-node.drop-inside {
  background: rgba(59,130,246,0.12);
  border-color: var(--accent-primary);
}
.expand-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none;
  color: var(--foreground-muted);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.expand-btn.invisible { visibility: hidden; }
.expand-btn:hover { color: var(--foreground-secondary); }
.node-icon {
  width: 28px; height: 28px;
  border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.node-body { flex: 1; min-width: 0; }
.node-label-row { display: flex; align-items: center; gap: 6px; }
.node-label { font-size: var(--font-size-sm); color: var(--foreground-primary); white-space: nowrap; }
.status-badge {
  font-size: 10px; padding: 1px 6px; border-radius: var(--radius-sm);
}
.node-key {
  font-size: var(--font-size-xs);
  font-family: monospace;
  color: var(--foreground-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-actions {
  display: flex; gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.tree-node:hover .node-actions { opacity: 1; }
.action-btn {
  padding: 4px;
  background: none; border: none;
  color: var(--foreground-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: flex; align-items: center;
}
.action-btn:hover { background: rgba(59,130,246,0.12); color: var(--accent-primary); }
.action-btn.danger:hover { background: rgba(244,63,94,0.12); color: #fb7185; }
.text-amber-300 { color: #fcd34d; }
.text-sky-300 { color: #7dd3fc; }
.text-violet-300 { color: #c4b5fd; }
.bg-amber-500\/15 { background: rgba(245,158,11,0.15); }
.bg-sky-500\/15 { background: rgba(14,165,233,0.15); }
.bg-violet-500\/15 { background: rgba(139,92,246,0.15); }
.border-amber-500\/30 { border: 1px solid rgba(245,158,11,0.3); }
.border-sky-500\/30 { border: 1px solid rgba(14,165,233,0.3); }
.border-violet-500\/30 { border: 1px solid rgba(139,92,246,0.3); }
</style>
