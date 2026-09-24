<script setup lang="ts">
/**
 * 右栏栏目视图——某个分组的全量知识库卡片列表（可检索、可翻页）。
 *
 * 由左栏分组的「查看更多」进入；分页走服务端 `search` / `page` 参数。
 */
import { computed, ref, watch } from 'vue'
import { Database, Search } from 'lucide-vue-next'
import { useKnowledgeBaseStore, KB_GROUPS } from '@/stores/knowledgeBase'
import type { KbScope } from '@/types/knowledgeBase'
import KbCard from './KbCard.vue'

const props = defineProps<{ scope: Exclude<KbScope, 'overview'> }>()

const store = useKnowledgeBaseStore()
const keyword = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const groupLabel = computed(
  () => KB_GROUPS.find((g) => g.id === props.scope)?.label || '',
)

const state = computed(() => store.groups[props.scope])

/** 「共享给我的」与「我的共享」在客户端过滤，分页无意义 */
const clientFiltered = computed(() => props.scope === 'sharedWithMe' || props.scope === 'sharedByMe')

const visibleItems = computed(() => {
  const items = state.value?.items || []
  const q = keyword.value.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (kb) =>
      kb.name.toLowerCase().includes(q) ||
      kb.description.toLowerCase().includes(q) ||
      kb.tags.some((t) => t.toLowerCase().includes(q)),
  )
})

function reload(page = 1) {
  if (clientFiltered.value) {
    // 这两类栏目数据量小，本地过滤即可
    return
  }
  void store.loadGroup(props.scope, page)
}

watch(() => props.scope, () => {
  keyword.value = ''
  reload(1)
})

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => reload(1), 300)
}

function onPageChange(page: number) {
  void store.loadGroup(props.scope, page)
}

function openKb(id: string) {
  void store.selectKb(id)
}
</script>

<template>
  <div class="kb-group-panel">
    <div class="panel-toolbar">
      <div class="search-wrap">
        <Search :size="16" class="search-icon" />
        <input
          v-model="keyword"
          type="text"
          :placeholder="`在「${groupLabel}」中检索…`"
          class="search-input"
          @input="onSearchInput"
        />
      </div>
      <span class="panel-count">共 {{ state?.total || 0 }} 个</span>
    </div>

    <div v-loading="state?.loading" class="panel-body">
      <div v-if="visibleItems.length" class="kb-grid">
        <KbCard
          v-for="kb in visibleItems"
          :key="kb.id"
          :kb="kb"
          @click="openKb(kb.id)"
        />
      </div>
      <el-empty v-else-if="!state?.loading" description="暂无知识库" />

      <div
        v-if="!clientFiltered && (state?.total || 0) > (state?.pageSize || 12)"
        class="panel-pager"
      >
        <el-pagination
          layout="prev, pager, next"
          background
          :current-page="state?.page || 1"
          :page-size="state?.pageSize || 12"
          :total="state?.total || 0"
          @current-change="onPageChange"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.kb-group-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-wrap {
  position: relative;
  flex: 1;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-secondary);
  pointer-events: none;
  z-index: 1;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.search-input::placeholder {
  color: var(--foreground-muted);
}

.search-input:focus {
  border-color: rgba(59, 130, 246, 0.4);
}

.panel-count {
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.kb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.panel-pager {
  display: flex;
  justify-content: center;
  padding: 18px 0 4px;
}
</style>
