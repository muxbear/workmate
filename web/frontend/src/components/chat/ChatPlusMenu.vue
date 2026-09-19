<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  BookOpen,
  Bot,
  ChevronRight,
  FileText,
  ImagePlus,
  Link2,
  Search,
  Settings2,
  Sparkles,
  Zap,
} from 'lucide-vue-next'
import { fetchExperts } from '@/services/expertApi'
import { fetchSkills } from '@/services/skillApi'
import { fetchKnowledgeBases } from '@/services/knowledgeBaseApi'
import { fetchMcpTools } from '@/services/mcpApi'
import { useChatStore } from '@/stores/chat'
import type { Expert } from '@/types/expert'
import type { Skill } from '@/types/skill'
import type { KB } from '@/types/knowledgeBase'
import type { McpTool } from '@/types/mcp'

/**
 * 输入卡「+」上拉菜单（对齐桌面版「新建任务」）：五个一级项，hover 滑出右侧二级菜单。
 */
const emit = defineEmits<{
  close: []
  'pick-files': [kind: 'file' | 'image']
  'toggle-skill': [skill: Skill]
  navigate: [path: string]
}>()

const chatStore = useChatStore()

const NARROW_QUERY = '(max-width: 768px)'
/** 窄屏（< 768px）时菜单退化为单列抽屉：一级项点击内联展开二级内容 */
const isNarrow = ref(false)
let mediaQuery: MediaQueryList | null = null
let mediaHandler: ((event: MediaQueryListEvent) => void) | null = null

function syncNarrow(matches: boolean) {
  isNarrow.value = matches
  if (!matches) activeSubmenu.value = null
}

const activeSubmenu = ref<string | null>(null)
const expertSearch = ref('')
const skillSearch = ref('')
const kbSearch = ref('')
const connectorSearch = ref('')

const experts = ref<Expert[]>([])
const skills = ref<Skill[]>([])
const kbs = ref<KB[]>([])
const connectors = ref<McpTool[]>([])
const loading = ref({ expert: false, skill: false, kb: false, connector: false })

const modeOptions = [
  { key: 'default', label: '默认', desc: '由智能体自行判断' },
  { key: 'files', label: '引用上传文件', desc: '以上传附件为主要上下文' },
  { key: 'knowledge', label: '引用知识库', desc: '限定知识库检索范围' },
] as const

const filteredExperts = computed(() => {
  const keyword = expertSearch.value.trim().toLowerCase()
  if (!keyword) return experts.value
  return experts.value.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) || item.title.toLowerCase().includes(keyword),
  )
})

const filteredSkills = computed(() => {
  const keyword = skillSearch.value.trim().toLowerCase()
  if (!keyword) return skills.value
  return skills.value.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) || item.description.toLowerCase().includes(keyword),
  )
})

const filteredKbs = computed(() => {
  const keyword = kbSearch.value.trim().toLowerCase()
  if (!keyword) return kbs.value
  return kbs.value.filter((item) => item.name.toLowerCase().includes(keyword))
})

const installedConnectors = computed(() => connectors.value.filter((item) => item.installed))

const filteredConnectors = computed(() => {
  const keyword = connectorSearch.value.trim().toLowerCase()
  if (!keyword) return installedConnectors.value
  return installedConnectors.value.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) || item.description.toLowerCase().includes(keyword),
  )
})

async function ensureExperts() {
  if (experts.value.length > 0 || loading.value.expert) return
  loading.value.expert = true
  try {
    const res = await fetchExperts({ page: 1, pageSize: 50, status: 'active' })
    experts.value = res.items
  } catch {
    experts.value = []
  } finally {
    loading.value.expert = false
  }
}

async function ensureSkills() {
  if (skills.value.length > 0 || loading.value.skill) return
  loading.value.skill = true
  try {
    const res = await fetchSkills({ page: 1, page_size: 50, enabled: true })
    skills.value = res.items
  } catch {
    skills.value = []
  } finally {
    loading.value.skill = false
  }
}

async function ensureKbs() {
  if (kbs.value.length > 0 || loading.value.kb) return
  loading.value.kb = true
  try {
    kbs.value = await fetchKnowledgeBases({ page: 1, page_size: 50 })
  } catch {
    kbs.value = []
  } finally {
    loading.value.kb = false
  }
}

async function ensureConnectors() {
  if (connectors.value.length > 0 || loading.value.connector) return
  loading.value.connector = true
  try {
    connectors.value = await fetchMcpTools()
  } catch {
    connectors.value = []
  } finally {
    loading.value.connector = false
  }
}

function hoverSubmenu(key: string) {
  if (isNarrow.value) return
  openSubmenu(key)
}

function toggleSubmenu(key: string) {
  if (activeSubmenu.value === key) {
    activeSubmenu.value = null
    return
  }
  openSubmenu(key)
}

function openSubmenu(key: string) {
  activeSubmenu.value = key
  if (key === 'expert') void ensureExperts()
  if (key === 'skill') void ensureSkills()
  if (key === 'file') void ensureKbs()
  if (key === 'connector') void ensureConnectors()
}

function pickExpert(expert: Expert) {
  chatStore.setExpert({ id: expert.id, name: expert.name })
  emit('close')
}

function clearExpert() {
  chatStore.setExpert(null)
  emit('close')
}

function pickSkill(skill: Skill) {
  emit('toggle-skill', skill)
}

function toggleKb(id: string) {
  const ids = chatStore.selection.kbIds
  chatStore.setSelection({
    kbIds: ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
  })
}

function pickMode(key: 'default' | 'files' | 'knowledge') {
  chatStore.setMode(key)
  emit('close')
}
function go(path: string) {
  emit('navigate', path)
  emit('close')
}
onMounted(() => {
  if (!window.matchMedia) return
  mediaQuery = window.matchMedia(NARROW_QUERY)
  syncNarrow(mediaQuery.matches)
  mediaHandler = (event: MediaQueryListEvent) => syncNarrow(event.matches)
  mediaQuery.addEventListener('change', mediaHandler)
})

onUnmounted(() => {
  if (mediaQuery && mediaHandler) mediaQuery.removeEventListener('change', mediaHandler)
  mediaQuery = null
  mediaHandler = null
})
</script>

<template>
  <div class="plus-menu" :class="{ 'plus-menu--narrow': isNarrow }">
    <div v-if="isNarrow" class="plus-menu-head">
      <span>添加</span>
      <button class="plus-menu-close" title="关闭" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>
    <div class="plus-item-wrap" @mouseenter="hoverSubmenu('file')">
      <button class="plus-item" type="button" @click="toggleSubmenu('file')">
        <FileText :size="15" />
        <span class="plus-item-text">添加文件</span>
        <ChevronRight :size="13" class="plus-chevron" />
      </button>
      <div
        v-if="activeSubmenu === 'file'"
        class="plus-submenu"
        :class="{ 'plus-submenu--inline': isNarrow }"
      >
        <button class="plus-sub-item" type="button" @click="emit('pick-files', 'file')">
          <FileText :size="14" />
          <span>上传本地文件</span>
        </button>
        <button class="plus-sub-item" type="button" @click="emit('pick-files', 'image')">
          <ImagePlus :size="14" />
          <span>上传图片</span>
        </button>
        <div class="plus-divider"></div>
        <div class="plus-search">
          <Search :size="12" />
          <input
            v-model="kbSearch"
            type="text"
            placeholder="搜索知识库"
            class="plus-search-input"
          />
        </div>
        <div class="plus-list">
          <button
            v-for="kb in filteredKbs"
            :key="kb.id"
            class="plus-sub-item"
            type="button"
            @click="toggleKb(kb.id)"
          >
            <BookOpen :size="14" />
            <span class="plus-sub-text">{{ kb.name }}</span>
            <span v-if="chatStore.selection.kbIds.includes(kb.id)" class="plus-check">✓</span>
          </button>
          <p v-if="filteredKbs.length === 0" class="plus-empty">暂无可用知识库</p>
        </div>
      </div>
    </div>

    <div class="plus-item-wrap" @mouseenter="hoverSubmenu('mode')">
      <button class="plus-item" type="button" @click="toggleSubmenu('mode')">
        <Zap :size="15" />
        <span class="plus-item-text">模式</span>
        <ChevronRight :size="13" class="plus-chevron" />
      </button>
      <div
        v-if="activeSubmenu === 'mode'"
        class="plus-submenu"
        :class="{ 'plus-submenu--inline': isNarrow }"
      >
        <button
          v-for="option in modeOptions"
          :key="option.key"
          class="plus-sub-item plus-sub-item--mode"
          type="button"
          @click="pickMode(option.key)"
        >
          <Zap :size="14" />
          <span class="plus-sub-text">{{ option.label }}</span>
          <span
            class="plus-switch"
            :class="{ 'plus-switch--on': chatStore.selection.mode === option.key }"
          >
            <span class="plus-switch-knob"></span>
          </span>
        </button>
      </div>
    </div>

    <div class="plus-item-wrap" @mouseenter="hoverSubmenu('expert')">
      <button class="plus-item" type="button" @click="toggleSubmenu('expert')">
        <Bot :size="15" />
        <span class="plus-item-text">专家</span>
        <ChevronRight :size="13" class="plus-chevron" />
      </button>
      <div
        v-if="activeSubmenu === 'expert'"
        class="plus-submenu"
        :class="{ 'plus-submenu--inline': isNarrow }"
      >
        <div class="plus-search">
          <Search :size="12" />
          <input
            v-model="expertSearch"
            type="text"
            placeholder="搜索专家"
            class="plus-search-input"
          />
        </div>
        <div class="plus-list">
          <button
            v-for="expert in filteredExperts"
            :key="expert.id"
            class="plus-sub-item"
            type="button"
            @click="pickExpert(expert)"
          >
            <Bot :size="14" />
            <span class="plus-sub-text">{{ expert.name }}</span>
            <span v-if="chatStore.selection.expertId === expert.id" class="plus-check">✓</span>
          </button>
          <p v-if="filteredExperts.length === 0" class="plus-empty">无匹配专家</p>
        </div>
        <div class="plus-divider"></div>
        <button class="plus-sub-item" type="button" @click="go('/experts')">
          <Sparkles :size="14" />
          <span>召唤更多专家</span>
        </button>
      </div>
    </div>

    <div class="plus-item-wrap" @mouseenter="hoverSubmenu('skill')">
      <button class="plus-item" type="button" @click="toggleSubmenu('skill')">
        <Sparkles :size="15" />
        <span class="plus-item-text">技能</span>
        <ChevronRight :size="13" class="plus-chevron" />
      </button>
      <div
        v-if="activeSubmenu === 'skill'"
        class="plus-submenu"
        :class="{ 'plus-submenu--inline': isNarrow }"
      >
        <div class="plus-search">
          <Search :size="12" />
          <input
            v-model="skillSearch"
            type="text"
            placeholder="搜索技能"
            class="plus-search-input"
          />
        </div>
        <div class="plus-list">
          <button
            v-for="skill in filteredSkills"
            :key="skill.id"
            class="plus-sub-item"
            type="button"
            @click="pickSkill(skill)"
          >
            <Sparkles :size="14" />
            <span class="plus-sub-text">{{ skill.name }}</span>
            <span v-if="chatStore.selection.skillIds.includes(skill.id)" class="plus-check">✓</span>
          </button>
          <p v-if="filteredSkills.length === 0" class="plus-empty">无匹配技能</p>
        </div>
        <div class="plus-divider"></div>
        <button class="plus-sub-item" type="button" @click="go('/skills')">
          <Settings2 :size="14" />
          <span>管理技能</span>
        </button>
      </div>
    </div>

    <div class="plus-item-wrap" @mouseenter="hoverSubmenu('connector')">
      <button class="plus-item" type="button" @click="toggleSubmenu('connector')">
        <Link2 :size="15" />
        <span class="plus-item-text">连接器</span>
        <ChevronRight :size="13" class="plus-chevron" />
      </button>
      <div
        v-if="activeSubmenu === 'connector'"
        class="plus-submenu"
        :class="{ 'plus-submenu--inline': isNarrow }"
      >
        <div class="plus-search">
          <Search :size="12" />
          <input
            v-model="connectorSearch"
            type="text"
            placeholder="搜索连接器"
            class="plus-search-input"
          />
        </div>
        <div class="plus-list">
          <button
            v-for="item in filteredConnectors"
            :key="item.id"
            class="plus-sub-item"
            type="button"
            @click="go('/mcp')"
          >
            <Link2 :size="14" />
            <span class="plus-sub-text">{{ item.name }}</span>
          </button>
          <p v-if="filteredConnectors.length === 0" class="plus-empty">暂无已连接的工具</p>
        </div>
        <div class="plus-divider"></div>
        <button class="plus-sub-item" type="button" @click="go('/mcp')">
          <Settings2 :size="14" />
          <span>管理连接器</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plus-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 180px;
  padding: 4px;
  background: var(--surface-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  z-index: 220;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plus-item-wrap {
  position: relative;
}

.plus-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.plus-item-wrap:hover .plus-item {
  background: var(--surface-secondary);
}

.plus-item-text {
  flex: 1;
  text-align: left;
}

.plus-chevron {
  color: var(--foreground-muted);
  flex-shrink: 0;
}

.plus-submenu {
  position: absolute;
  left: calc(100% + 4px);
  top: 0;
  min-width: 210px;
  padding: 4px;
  background: var(--surface-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  z-index: 221;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.plus-sub-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.plus-sub-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.plus-sub-text {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plus-check {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.plus-empty {
  margin: 0;
  padding: 10px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.plus-divider {
  margin: 4px 6px;
  border-top: 1px solid var(--border-subtle);
}

.plus-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
}

.plus-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  padding: 6px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  color: var(--foreground-muted);
}

.plus-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
}

.plus-switch {
  position: relative;
  width: 30px;
  height: 17px;
  border-radius: var(--radius-full);
  background: var(--border-medium);
  flex-shrink: 0;
  transition: background 0.15s ease;
}

.plus-switch--on {
  background: var(--accent-primary);
}

.plus-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: var(--radius-full);
  background: #fff;
  transition: transform 0.15s ease;
}

.plus-switch--on .plus-switch-knob {
  transform: translateX(13px);
}

.plus-menu--narrow {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 12px;
  min-width: 0;
  max-height: 72vh;
  overflow-y: auto;
}

.plus-menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 8px;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.plus-menu-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.plus-menu-close:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.plus-submenu--inline {
  position: static;
  left: auto;
  top: auto;
  margin: 0 0 6px;
  padding: 4px;
  border: none;
  box-shadow: none;
  background: var(--surface-secondary);
  min-width: 0;
}

.plus-menu--narrow .plus-list {
  max-height: 38vh;
}

.plus-menu--narrow .plus-menu-item,
.plus-menu--narrow .plus-item {
  padding: 10px;
}
</style>
