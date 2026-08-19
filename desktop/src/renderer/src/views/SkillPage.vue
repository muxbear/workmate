<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useCatalogStore, type SkillItem } from '@store/catalog'
import { useSkillSyncStore } from '@store/skillSync'

const search = ref('')
const catalog = useCatalogStore()
const skillSync = useSkillSyncStore()

/** 技能安装提示（轻量 toast，点击技能卡片右侧 + 后展示） */
const skillToast = ref('')
let skillToastTimer: ReturnType<typeof setTimeout> | null = null

const showToast = (text: string): void => {
  skillToast.value = text
  if (skillToastTimer) clearTimeout(skillToastTimer)
  skillToastTimer = setTimeout(() => {
    skillToast.value = ''
  }, 1800)
}

const installSkill = (skill: SkillItem): void => {
  showToast(`${skill.name}技能已安装，去试试`)
}

const authorizeAndSync = async (): Promise<void> => {
  try {
    await skillSync.authorize()
    await skillSync.sync()
  } catch (err) {
    showToast(err instanceof Error ? err.message : '同步失败')
  }
}

const resync = async (): Promise<void> => {
  try {
    await skillSync.sync()
    showToast('技能同步成功')
  } catch (err) {
    showToast(err instanceof Error ? err.message : '同步失败')
  }
}

onMounted(() => {
  void skillSync.loadStatus()
  void skillSync.loadCachedSkills()
})
</script>

<template>
  <div class="skill-page">
    <div class="top-bar">
      <h1 class="page-title">技能</h1>
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
        <input v-model="search" type="text" placeholder="搜索技能" class="search-input" />
      </div>
    </div>

    <div class="page-body">
      <div v-if="skillSync.status === 'unknown' || skillSync.status === 'syncing'" class="sync-state">
        {{ skillSync.status === 'syncing' ? '正在同步技能...' : '正在加载技能同步状态...' }}
      </div>

      <div v-else-if="skillSync.status === 'unauthorized'" class="sync-empty">
        <div class="sync-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </div>
        <p class="sync-empty-title">请先从服务器同步技能</p>
        <p class="sync-empty-desc">同步后，这里会展示 Web 版已配置的技能。</p>
        <button class="sync-empty-btn" type="button" @click="authorizeAndSync">开始同步</button>
      </div>

      <template v-else>
        <div class="sec-intro">
          <div>
            <h2 class="sec-title">技能广场</h2>
            <p class="sec-desc">为KE-WORK扩展专项能力，一键调用即可赋能任意对话</p>
          </div>
          <button class="resync-btn" type="button" @click="resync">重新同步</button>
        </div>

        <div v-if="skillSync.error" class="sync-error">{{ skillSync.error }}</div>

        <div v-if="catalog.skillItems.length === 0" class="sync-empty">
          <p class="sync-empty-title">暂无技能</p>
          <p class="sync-empty-desc">请在 Web 版中配置技能后重新同步。</p>
        </div>

        <div v-else class="skill-grid">
          <div
            v-for="skill in catalog.skillItems.filter(
              (s) => s.name.includes(search) || s.desc.includes(search)
            )"
            :key="skill.id"
            class="skill-card"
          >
            <div class="skill-icon" :style="{ background: skill.color }">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                stroke-width="2"
              >
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </div>
            <div class="skill-info">
              <div class="skill-head">
                <p class="skill-name">{{ skill.name }}</p>
                <span v-if="skill.count" class="skill-count">{{ skill.count }}</span>
                <button
                  class="skill-install-btn"
                  type="button"
                  title="安装技能"
                  @click="installSkill(skill)"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
              <p class="skill-desc">{{ skill.desc }}</p>
            </div>
          </div>
        </div>
      </template>
    </div>

    <Transition name="toast">
      <div v-if="skillToast" class="skill-toast">{{ skillToast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.skill-page {
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

.sec-desc {
  font-size: 12px;
  color: var(--kw-color-text-muted);
  margin: 4px 0 0;
}

.sec-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.sync-state,
.sync-empty {
  display: flex;
  min-height: 300px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--kw-color-text-muted);
  text-align: center;
}

.sync-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
}

.sync-empty-title {
  margin: 0;
  color: var(--kw-color-text);
  font-size: 15px;
  font-weight: 600;
}

.sync-empty-desc {
  margin: 0;
  color: var(--kw-color-text-secondary);
  font-size: 12px;
}

.sync-empty-btn,
.resync-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}

.resync-btn {
  flex-shrink: 0;
}

.sync-error {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.08);
  color: var(--kw-color-text-error);
  font-size: 12px;
}

.skill-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.skill-card {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: var(--kw-color-surface-soft);
  border: 1px solid var(--kw-color-border-brand);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.skill-card:hover {
  border-color: rgba(8, 145, 178, 0.28);
  background: var(--kw-color-surface);
}

.skill-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.skill-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  margin: 0;
}

.skill-count {
  font-size: 10px;
  color: var(--kw-color-text-faint);
}

.skill-desc {
  font-size: 11px;
  color: var(--kw-color-text-secondary);
  line-height: 1.4;
  margin: 0 0 12px;
}

.skill-install-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 8px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.skill-install-btn:hover {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.skill-install-btn:active {
  transform: scale(0.92);
}

.skill-toast {
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

@media (max-width: 1200px) {
  .skill-grid {
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

  .skill-grid {
    grid-template-columns: 1fr;
  }
}
</style>
