<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { experts, useCatalogStore } from '@store/catalog'

const emit = defineEmits<{ summon: [] }>()

/** 数据与「+」菜单共源（catalog store） */
const catalog = useCatalogStore()

const expertFilter = ref('全部')
const sort = ref<'综合' | '最新'>('综合')
const search = ref('')
const syncStatus = ref<'idle' | 'syncing' | 'unauthorized'>('idle')

const featuredScenes = [
  {
    id: 'content',
    label: '内容创作',
    color: 'linear-gradient(135deg,#f59e0b,#d97706)',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.2)',
    items: ['内容创作专家团队', '内容创作专家', '小红书创作专家']
  },
  {
    id: 'invest',
    label: '投资分析',
    color: 'linear-gradient(135deg,#0891b2,#0e7490)',
    bg: 'rgba(8,145,178,0.08)',
    border: 'rgba(8,145,178,0.2)',
    items: ['分众分析图团队', '股权投资研究专家', '腾讯投研配置策略']
  },
  {
    id: 'legal',
    label: '法律查查',
    color: 'linear-gradient(135deg,#6366f1,#4f46e5)',
    bg: 'rgba(99,102,241,0.08)',
    border: 'rgba(99,102,241,0.2)',
    items: ['深海律法专家团队', '合同审查专家', '财务合同专家']
  },
  {
    id: 'sme',
    label: '小微企业',
    color: 'linear-gradient(135deg,#10b981,#059669)',
    bg: 'rgba(16,185,129,0.08)',
    border: 'rgba(16,185,129,0.2)',
    items: ['小微企业经营顾问', '财税合规专家', '企业增长策略师']
  }
]

const expertFilters = ['全部', 'SPC', 'AI工具专家', '产品设计', '技术研发', '创业投资', '法律财税']

const filteredExperts = computed(() =>
  experts.value.filter(
    (e) =>
      (expertFilter.value === '全部' || e.category === expertFilter.value) &&
      (e.name.includes(search.value) ||
        e.title.includes(search.value) ||
        e.tags.some((t) => t.includes(search.value)))
  )
)

/** 召唤专家：与“+ 菜单 → 专家 → 选择该专家”共用同一 catalog.setExpert 逻辑 */
const summonExpert = (id: string): void => {
  catalog.setExpert(id)
  emit('summon')
}

async function loadExperts() {
  const cachedRes = await window.api.expert.getCachedExperts()
  const cachedData = cachedRes.data
  if (cachedRes.success && cachedData && cachedData.length > 0) {
    catalog.setExperts(cachedData)
  }

  const statusRes = await window.api.expert.getStatus()
  const statusData = statusRes.data
  if (statusRes.success && statusData && statusData.status === 'authorized') {
    syncStatus.value = 'syncing'
    const syncRes = await window.api.expert.sync()
    if (syncRes.success && syncRes.data) {
      catalog.setExperts(syncRes.data.experts)
    }
    syncStatus.value = 'idle'
  } else {
    syncStatus.value = 'unauthorized'
  }
}

async function handleSync() {
  const statusRes = await window.api.expert.getStatus()
  const statusData = statusRes.data
  if (statusRes.success && statusData && statusData.status !== 'authorized') {
    await window.api.expert.authorize()
  }

  syncStatus.value = 'syncing'
  const res = await window.api.expert.sync()
  if (res.success && res.data) {
    catalog.setExperts(res.data.experts)
  }
  syncStatus.value = 'idle'
}

onMounted(() => {
  void loadExperts()
})
</script>

<template>
  <div class="expert-page">
    <div class="top-bar">
      <h1 class="page-title">专家</h1>
      <div class="top-spacer"></div>
      <div class="search-box">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input v-model="search" type="text" placeholder="搜索专家" class="search-input" />
      </div>
      <button class="sync-btn" :disabled="syncStatus === 'syncing'" @click="handleSync">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        同步专家
      </button>
    </div>

    <div class="page-body">
      <section class="scene-section">
        <h2 class="sec-title">精选场景</h2>
        <div class="scene-grid">
          <div
            v-for="scene in featuredScenes"
            :key="scene.id"
            class="scene-card"
            :style="{ background: scene.bg, borderColor: scene.border }"
          >
            <div class="scene-card-head">
              <div class="scene-card-icon" :style="{ background: scene.color }">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  stroke-width="2"
                >
                  <path
                    d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2z"
                  />
                </svg>
              </div>
              <span class="scene-card-label">{{ scene.label }}</span>
            </div>
            <div class="scene-items">
              <div v-for="item in scene.items" :key="item" class="scene-item">
                <div class="scene-item-dot" :style="{ background: scene.color }"></div>
                <span>{{ item }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="sec-header">
          <h2 class="sec-title">专家 · 专家园</h2>
          <div class="sec-spacer"></div>
          <div class="sort-btns">
            <button
              v-for="s in ['综合', '最新'] as const"
              :key="s"
              :class="['sort-btn', { 'sort-btn--active': sort === s }]"
              @click="sort = s"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div class="filter-chips">
          <button
            v-for="f in expertFilters"
            :key="f"
            :class="['filter-chip', { 'filter-chip--active': expertFilter === f }]"
            @click="expertFilter = f"
          >
            {{ f }}
          </button>
        </div>

        <div class="expert-grid">
          <div v-for="expert in filteredExperts" :key="expert.id" class="expert-card">
            <div class="expert-card-head">
              <div class="expert-avatar" :style="{ background: expert.color }">
                {{ expert.initials }}
              </div>
              <div class="expert-info">
                <p class="expert-name">{{ expert.name }}</p>
                <p class="expert-title">{{ expert.title }}</p>
              </div>
              <button
                class="expert-summon-btn"
                type="button"
                title="召唤该专家"
                @click="summonExpert(expert.id)"
              >
                召唤
              </button>
            </div>
            <div class="expert-tags">
              <span v-for="tag in expert.tags.slice(0, 3)" :key="tag" class="expert-tag">{{
                tag
              }}</span>
            </div>
            <p class="expert-desc">{{ expert.desc }}</p>
            <div class="expert-foot">
              <div class="expert-rating">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="#f59e0b"
                  stroke="#f59e0b"
                  stroke-width="1"
                >
                  <polygon
                    points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                  />
                </svg>
                {{ expert.rating }}
              </div>
              <span class="expert-users">{{ expert.users }} 使用</span>
            </div>
          </div>
          <div v-if="filteredExperts.length === 0" class="grid-empty">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <p>暂无符合条件的专家</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.expert-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--kw-color-surface);
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
}

.top-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 16px 24px 0;
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}

.page-title {
  margin: 0 16px 0 0;
  padding-bottom: 10px;
  color: var(--kw-color-text);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.top-spacer {
  flex: 1;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  background: var(--kw-color-input-bg);
  border: 1px solid var(--kw-color-border-brand);
  margin-right: 8px;
  color: var(--kw-color-text-faint);
}

.search-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  width: 128px;
}

.search-input::placeholder {
  color: var(--kw-color-text-faint);
}

.sync-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 8px;
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.25);
  margin-bottom: -1px;
}

.page-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  scrollbar-width: none;
}

.page-body::-webkit-scrollbar {
  display: none;
}

.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}

.sec-header {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.sec-spacer {
  flex: 1;
}

.sort-btns {
  display: flex;
  gap: 2px;
  font-size: 12px;
}

.sort-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-faint);
  font-family: inherit;
  cursor: pointer;
}

.sort-btn--active {
  color: var(--kw-color-brand);
  font-weight: 600;
}

.scene-section {
  margin-bottom: 24px;
}

.scene-section .sec-title {
  margin-bottom: 12px;
}

.scene-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.scene-card {
  border-radius: 12px;
  padding: 14px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: box-shadow 0.15s;
}

.scene-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.scene-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.scene-card-icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.scene-card-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.scene-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scene-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--kw-color-text-secondary);
}

.scene-item-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.filter-chips {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}

.filter-chip {
  padding: 4px 12px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 999px;
  background: var(--kw-color-input-bg);
  color: var(--kw-color-text-muted);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.filter-chip--active {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  border-color: var(--kw-color-brand);
}

.expert-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.expert-card {
  padding: 16px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.expert-card:hover {
  border-color: rgba(8, 145, 178, 0.28);
  background: var(--kw-color-surface);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.expert-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.expert-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kw-color-on-accent);
  font-size: 16px;
  font-weight: 700;
  flex-shrink: 0;
}

.expert-info {
  flex: 1;
  min-width: 0;
}

.expert-summon-btn {
  flex-shrink: 0;
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
  font-size: 11px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  opacity: 0;
  visibility: hidden;
  transform: translateX(4px);
  transition:
    opacity 0.15s ease,
    visibility 0.15s ease,
    transform 0.15s ease,
    background-color 0.15s ease;
}

.expert-card:hover .expert-summon-btn {
  opacity: 1;
  visibility: visible;
  transform: translateX(0);
}

.expert-summon-btn:hover {
  background: var(--kw-color-brand-strong);
}

.expert-summon-btn:active {
  transform: scale(0.96);
}

.expert-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.expert-title {
  font-size: 11px;
  color: var(--kw-color-text-muted);
  margin: 0;
}

.expert-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}

.expert-tag {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 10px;
  font-weight: 500;
}

.expert-desc {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  line-height: 1.5;
  margin: 0 0 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.expert-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.expert-rating {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.expert-users {
  font-size: 10px;
  color: var(--kw-color-text-faint);
}

.grid-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 64px 0;
  color: #cbd5e1;
  font-size: 14px;
}

@media (max-width: 1200px) {
  .scene-grid,
  .expert-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .top-bar {
    padding: 12px 16px 0;
  }

  .page-body {
    padding: 16px;
  }

  .scene-grid,
  .expert-grid {
    grid-template-columns: 1fr;
  }

  .sync-btn {
    display: none;
  }
}
</style>
