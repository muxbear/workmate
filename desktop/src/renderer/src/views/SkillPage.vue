<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCatalogStore, type SkillItem } from '@store/catalog'
import { useSkillSyncStore } from '@store/skillSync'
import { useSettingsStore } from '@store/settings'

const settingsStore = useSettingsStore()
const search = ref('')
const catalog = useCatalogStore()
const skillSync = useSkillSyncStore()

/** 技能操作提示（轻量 toast） */
const skillToast = ref('')
let skillToastTimer: ReturnType<typeof setTimeout> | null = null

const showToast = (text: string): void => {
  skillToast.value = text
  if (skillToastTimer) clearTimeout(skillToastTimer)
  skillToastTimer = setTimeout(() => {
    skillToast.value = ''
  }, 2200)
}

/** 页面是否已有可展示技能（本地优先：本地有数据就不显示同步空态） */
const hasSkills = computed(() => catalog.skillItems.length > 0)

/** 安装技能到主智能体（含脚本运行时环境准备） */
const installSkill = async (skill: SkillItem): Promise<void> => {
  const ok = await skillSync.install(skill.id)
  showToast(ok ? `${skill.name} 已安装，去试试` : (skillSync.error ?? '安装失败'))
}

/** 从主智能体移除技能（保留本地技能包） */
const uninstallSkill = async (skill: SkillItem): Promise<void> => {
  const ok = await skillSync.uninstall(skill.id)
  showToast(ok ? `${skill.name} 已从主智能体移除` : (skillSync.error ?? '移除失败'))
}

/** 删除本地技能（会同时取消安装；重新同步时以服务端为准） */
const deleteSkill = async (skill: SkillItem): Promise<void> => {
  const confirmed = window.confirm(
    `确定删除技能「${skill.name}」吗？此操作仅从本机移除；若服务端仍存在该技能，下次重新同步会再次出现。`
  )
  if (!confirmed) return
  const ok = await skillSync.remove(skill.id)
  showToast(ok ? `${skill.name} 已删除` : (skillSync.error ?? '删除失败'))
}

const authorizeAndSync = async (): Promise<void> => {
  const ok = await skillSync.sync()
  showToast(ok ? '技能同步成功' : (skillSync.error ?? '同步失败'))
}

const resync = async (): Promise<void> => {
  const ok = await skillSync.sync()
  if (!ok) {
    showToast(skillSync.error ?? '同步失败')
    return
  }
  const stats = skillSync.stats
  showToast(stats && stats.failed > 0 ? `同步完成，${stats.failed} 个技能失败` : '技能同步成功')
}

onMounted(() => {
  void skillSync.loadStatus()
  // 本地优先：先读 ~/.ke-work/skills/skills.json，无本地数据时才提示同步
  void skillSync.loadLocal()
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
      <div
        v-if="!hasSkills && (skillSync.status === 'unknown' || skillSync.syncing)"
        class="sync-state"
      >
        {{ skillSync.syncing ? '正在同步技能...' : '正在加载本地技能...' }}
      </div>

      <div v-else-if="!hasSkills && skillSync.status === 'unauthorized'" class="sync-empty">
        <div class="sync-empty-icon">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
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
            <p class="sec-desc">
              为{{ settingsStore.systemName }}扩展专项能力，一键调用即可赋能任意对话
            </p>
          </div>
          <button class="resync-btn" type="button" @click="resync">重新同步</button>
        </div>

        <div v-if="skillSync.syncing" class="sync-progress">
          <div class="sync-progress-fill" :style="{ width: skillSync.percent + '%' }" />
          <span class="sync-progress-text"
            >{{ skillSync.progressMessage }} {{ skillSync.percent }}%</span
          >
        </div>

        <div v-if="skillSync.error" class="sync-error">{{ skillSync.error }}</div>

        <div v-if="skillSync.installMessage" class="sync-hint">{{ skillSync.installMessage }}</div>

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
                <span v-if="skill.installed" class="skill-tag">已安装</span>
                <span v-if="skill.missing" class="skill-tag skill-tag--warn">目录缺失</span>
                <span v-if="skill.count" class="skill-count">{{ skill.count }}</span>
                <button
                  class="skill-install-btn"
                  :class="{ 'skill-install-btn--done': skill.installed }"
                  type="button"
                  :title="skill.installed ? '从主智能体移除' : '安装技能到主智能体'"
                  :disabled="skillSync.installingId === skill.id"
                  @click.stop="skill.installed ? uninstallSkill(skill) : installSkill(skill)"
                >
                  <svg
                    v-if="skill.installed"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <svg
                    v-else
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
                <button
                  class="skill-delete-btn"
                  type="button"
                  title="删除技能"
                  :disabled="skillSync.removingId === skill.id"
                  @click.stop="deleteSkill(skill)"
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
              <p class="skill-desc" :title="skill.desc">{{ skill.desc }}</p>
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

.sync-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.sync-progress-fill {
  height: 4px;
  max-width: 100%;
  border-radius: 999px;
  background: var(--kw-color-brand);
  transition: width 0.25s ease;
  flex: 1;
}

.sync-progress-text {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--kw-color-text-muted);
}

.sync-hint {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 12px;
}

.skill-tag {
  flex-shrink: 0;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 10px;
  font-weight: 500;
}

.skill-tag--warn {
  background: rgba(239, 68, 68, 0.1);
  color: var(--kw-color-text-error);
}

.skill-install-btn--done {
  background: var(--kw-color-brand);
  color: var(--kw-color-on-accent);
}

.skill-install-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  /* 描述过长时截断为两行，完整内容通过 title 悬浮提示 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
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

.skill-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 6px;
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

.skill-delete-btn:hover {
  background: rgba(239, 68, 68, 0.9);
  color: #fff;
}

.skill-delete-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
