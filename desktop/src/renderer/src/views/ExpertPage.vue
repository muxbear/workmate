<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@components/ConfirmDialog.vue'
import { experts, useCatalogStore, type Expert } from '@store/catalog'
import { useExpertSyncStore } from '@store/expertSync'

const emit = defineEmits<{ summon: [] }>()

/** 数据与「+」菜单共源（catalog store） */
const catalog = useCatalogStore()
const expertSync = useExpertSyncStore()

/** 待删除专家（删除确认弹窗依据；取消/确认后置空） */
const pendingDelete = ref<Expert | null>(null)

/** 操作提示（轻量 toast，与技能页一致） */
const pageToast = ref('')
let pageToastTimer: ReturnType<typeof setTimeout> | null = null

const showToast = (text: string): void => {
  pageToast.value = text
  if (pageToastTimer) clearTimeout(pageToastTimer)
  pageToastTimer = setTimeout(() => {
    pageToast.value = ''
  }, 2200)
}

const expertFilter = ref('全部')
const sort = ref<'综合' | '最新'>('综合')
const search = ref('')

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

/** 挂载：先展示本地 experts.json 数据，再读取同步状态（不自动触发网络同步） */
onMounted(() => {
  void expertSync.loadStatus()
  void expertSync.loadLocal()
})

async function handleSync(): Promise<void> {
  const ok = await expertSync.sync()
  if (!ok) {
    showToast(expertSync.error ?? '同步失败')
    return
  }
  const stats = expertSync.stats
  showToast(
    stats
      ? `同步完成：新增 ${stats.added} 个，更新 ${stats.updated} 个，保留本地 ${stats.kept} 个`
      : '专家数据同步完成'
  )
}

/** 打开删除确认弹窗（仅本机删除，服务端仍存在则下次同步会重新拉回） */
const requestDelete = (expert: Expert): void => {
  pendingDelete.value = expert
}

const cancelDelete = (): void => {
  pendingDelete.value = null
}

const confirmDelete = async (): Promise<void> => {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (!target) return
  const ok = await expertSync.removeExpert(target.id)
  showToast(ok ? `${target.name} 已删除` : (expertSync.error ?? '删除专家失败'))
}
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
      <button class="sync-btn" :disabled="expertSync.syncing" @click="handleSync">
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
        {{ expertSync.syncing ? '同步中…' : '同步专家' }}
      </button>
    </div>

    <Transition name="sync-fade">
      <div v-if="expertSync.syncing" class="sync-progress">
        <div class="sync-progress-bar">
          <div class="sync-progress-fill" :style="{ width: expertSync.percent + '%' }" />
        </div>
        <span class="sync-progress-text">
          {{ expertSync.progressMessage }} {{ expertSync.percent }}%
        </span>
      </div>
    </Transition>
    <div v-if="expertSync.error" class="sync-error">{{ expertSync.error }}</div>

    <div class="page-body">
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
                <div class="expert-name-row">
                  <p class="expert-name">{{ expert.name }}</p>
                  <span v-if="expert.version" class="expert-version" title="专家版本号">
                    v{{ expert.version }}
                  </span>
                </div>
                <p class="expert-title">{{ expert.title }}</p>
              </div>
              <div class="expert-card-actions">
                <button
                  class="expert-summon-btn"
                  type="button"
                  title="召唤该专家"
                  @click="summonExpert(expert.id)"
                >
                  召唤
                </button>
                <button
                  class="expert-delete-btn"
                  type="button"
                  title="删除专家（仅本机）"
                  :disabled="expertSync.removingId === expert.id"
                  @click.stop="requestDelete(expert)"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </div>
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

    <!-- 删除确认：仅删本机副本，服务端仍存在时下次同步会重新拉回 -->
    <ConfirmDialog
      v-if="pendingDelete"
      title="删除专家"
      :message="
        '确定删除专家「' +
        pendingDelete.name +
        '」吗？此操作仅从本机移除；若服务端仍存在该专家，下次重新同步会再次出现。'
      "
      confirm-text="删除"
      cancel-text="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <Transition name="toast">
      <div v-if="pageToast" class="expert-toast">{{ pageToast }}</div>
    </Transition>
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

/* 召唤 / 删除按钮：卡片悬浮或键盘聚焦时一并显现，静止时保持卡片简洁 */
.expert-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  opacity: 0;
  visibility: hidden;
  transform: translateX(4px);
  transition:
    opacity 0.15s ease,
    visibility 0.15s ease,
    transform 0.15s ease;
}

.expert-card:hover .expert-card-actions,
.expert-card:focus-within .expert-card-actions {
  opacity: 1;
  visibility: visible;
  transform: translateX(0);
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
  transition: background-color 0.15s ease;
}

.expert-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.12);
  color: var(--kw-color-text-error);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.expert-delete-btn:hover {
  background: rgba(239, 68, 68, 0.9);
  color: #fff;
}

.expert-delete-btn:active {
  transform: scale(0.92);
}

.expert-delete-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.expert-summon-btn:hover {
  background: var(--kw-color-brand-strong);
}

.expert-summon-btn:active {
  transform: scale(0.96);
}

.expert-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
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

/* 版本徽标：与 Web 端 ExpertCard 一致，便于确认同步是否更新到新版本 */
.expert-version {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--kw-color-border-brand);
  background: var(--kw-color-input-bg);
  color: var(--kw-color-text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
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

  .expert-grid {
    grid-template-columns: 1fr;
  }

  .sync-btn {
    display: none;
  }
}

/* 专家同步进度条与错误提示 */
.sync-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--kw-color-surface-soft);
  border-bottom: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
}

.sync-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--kw-color-bg-muted, #eff1f1);
  overflow: hidden;
}

.sync-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--kw-color-brand);
  transition: width 0.2s ease;
}

.sync-progress-text {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  white-space: nowrap;
}

.sync-error {
  padding: 8px 24px;
  font-size: 12px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.06);
  border-bottom: 1px solid rgba(220, 38, 38, 0.12);
}

.sync-fade-enter-active,
.sync-fade-leave-active {
  transition: opacity 0.2s ease;
}

.sync-fade-enter-from,
.sync-fade-leave-to {
  opacity: 0;
}

/* 同步 / 删除操作提示（与技能页 toast 一致） */
.expert-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.85);
  color: var(--kw-color-on-accent);
  font-size: 12px;
  z-index: 150;
  pointer-events: none;
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
</style>
