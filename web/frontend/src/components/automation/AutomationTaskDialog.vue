<script setup lang="ts">
/**
 * 定时任务（自动化）新建 / 编辑弹窗（对齐桌面版「新建自动化」）
 *
 * 组成：任务名称 + 任务描述/提示词（引用文件、技能、专家、知识库、模型、工作区、权限）+ 执行频率 + 有效期。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  BookOpen,
  Bot,
  Check,
  FileText,
  FolderOpen,
  ImagePlus,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import RichInput from '@/components/chat/RichInput.vue'
import { uploadAttachment } from '@/services/attachmentApi'
import { fetchExperts } from '@/services/expertApi'
import { fetchSkills } from '@/services/skillApi'
import { fetchKnowledgeBases } from '@/services/knowledgeBaseApi'
import { fetchProviders } from '@/services/modelApi'
import { useAutomationStore } from '@/stores/automation'
import {
  CONTEXT_MODE_LABEL,
  CYCLE_OPTIONS,
  INTERVAL_OPTIONS,
  WEEK_DAYS,
  buildFreqSummary,
  buildValiditySummary,
  createDefaultSchedule,
} from '@/types/automation'
import type {
  AutomationSchedule,
  AutomationTask,
  AutomationTaskDraft,
  ContextMode,
} from '@/types/automation'
import { createEmptySelection } from '@/types/chat'
import type { ChatInputPart, ChatSelection } from '@/types/chat'
import type { Expert } from '@/types/expert'
import type { Skill } from '@/types/skill'
import type { KB } from '@/types/knowledgeBase'

const props = defineProps<{ task?: AutomationTask | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const automation = useAutomationStore()

/* ---------- 基础状态 ---------- */
const title = ref('')
const parts = ref<ChatInputPart[]>([])
const selection = ref<ChatSelection>(createEmptySelection())
const schedule = ref<AutomationSchedule>(createDefaultSchedule())
const saving = ref(false)
const formError = ref('')
const richRef = ref<InstanceType<typeof RichInput> | null>(null)

const fileInputRef = ref<HTMLInputElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)

interface PendingAttachment {
  id: string
  filename: string
  progress: number
  status: 'uploading' | 'failed'
}

const pendingAttachments = ref<PendingAttachment[]>([])

/* ---------- 浮层状态 ---------- */
type MenuPanel = 'root' | 'file' | 'skill' | 'expert' | 'kb' | 'mode'

const menuOpen = ref(false)
const menuPanel = ref<MenuPanel>('root')
const modelOpen = ref(false)
const workspaceOpen = ref(false)
const permOpen = ref(false)
const riskKey = ref<'allowNetwork' | 'allowShell' | null>(null)
const riskChecked = ref(false)

const popupOpen = computed(
  () => menuOpen.value || modelOpen.value || workspaceOpen.value || permOpen.value,
)

function closePopups(): void {
  menuOpen.value = false
  modelOpen.value = false
  workspaceOpen.value = false
  permOpen.value = false
  menuPanel.value = 'root'
}

/* ---------- 候选数据 ---------- */
const experts = ref<Expert[]>([])
const skills = ref<Skill[]>([])
const kbs = ref<KB[]>([])
const modelOptions = ref<{ name: string; providerId: string; modelId: string }[]>([])
const expertSearch = ref('')
const skillSearch = ref('')
const kbSearch = ref('')
const loading = ref({ expert: false, skill: false, kb: false, model: false })

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

async function ensureExperts(): Promise<void> {
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

async function ensureSkills(): Promise<void> {
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

async function ensureKbs(): Promise<void> {
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

async function ensureModels(): Promise<void> {
  if (modelOptions.value.length > 0 || loading.value.model) return
  loading.value.model = true
  try {
    const providers = await fetchProviders()
    const list: { name: string; providerId: string; modelId: string }[] = []
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        if (model.type !== 'llm' && model.type !== 'multimodal') continue
        if (model.status === 'inactive' || model.status === 'deprecated') continue
        list.push({
          name: model.displayName || model.name,
          providerId: provider.id,
          modelId: model.id,
        })
      }
    }
    modelOptions.value = list
  } catch {
    modelOptions.value = []
  } finally {
    loading.value.model = false
  }
}

function openMenu(panel: MenuPanel): void {
  menuOpen.value = true
  menuPanel.value = panel
  modelOpen.value = false
  workspaceOpen.value = false
  permOpen.value = false
  if (panel === 'expert') void ensureExperts()
  if (panel === 'skill') void ensureSkills()
  if (panel === 'kb') void ensureKbs()
}

/** 打开模型下拉时关闭其它浮层 */
function toggleModelMenu(): void {
  modelOpen.value = !modelOpen.value
  menuOpen.value = false
  workspaceOpen.value = false
  permOpen.value = false
}

/** 打开工作区下拉时关闭其它浮层 */
function toggleWorkspaceMenu(): void {
  workspaceOpen.value = !workspaceOpen.value
  menuOpen.value = false
  modelOpen.value = false
  permOpen.value = false
}

/** 打开权限下拉时关闭其它浮层 */
function togglePermMenu(): void {
  permOpen.value = !permOpen.value
  menuOpen.value = false
  modelOpen.value = false
  workspaceOpen.value = false
}
/* ---------- 提示词与选择项 ---------- */
const promptText = computed(() =>
  parts.value
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string }).text)
    .join(''),
)

const hasPrompt = computed(
  () => promptText.value.trim().length > 0 || parts.value.some((part) => part.type === 'file'),
)

const modeLabel = computed(() => CONTEXT_MODE_LABEL[selection.value.mode])

const permissionLabel = computed(() => {
  const { allowNetwork, allowShell } = selection.value
  if (allowNetwork && allowShell) return '联网 + 代码执行'
  if (allowNetwork) return '联网访问'
  if (allowShell) return '代码执行'
  return '默认权限'
})

function onPartsUpdate(value: ChatInputPart[]): void {
  parts.value = value
}

function pickExpert(expert: Expert): void {
  selection.value.expertId = expert.id
  selection.value.expertName = expert.name
  menuOpen.value = false
}

function clearExpert(): void {
  selection.value.expertId = null
  selection.value.expertName = null
}

function toggleSkill(skill: Skill): void {
  const selected = selection.value.skillIds.includes(skill.id)
  if (selected) {
    selection.value.skillIds = selection.value.skillIds.filter((id) => id !== skill.id)
    richRef.value?.removeSkillToken(skill.id)
    return
  }
  selection.value.skillIds = [...selection.value.skillIds, skill.id]
  richRef.value?.insertSkill({ id: skill.id, name: skill.name })
}

function toggleKb(id: string): void {
  const selected = selection.value.kbIds
  selection.value.kbIds = selected.includes(id)
    ? selected.filter((item) => item !== id)
    : [...selected, id]
}

function pickMode(mode: ContextMode): void {
  selection.value.mode = mode
  menuOpen.value = false
}

function pickModel(option?: { name: string; providerId: string; modelId: string }): void {
  if (!option) {
    selection.value.model = null
    selection.value.providerId = null
    selection.value.modelId = null
  } else {
    selection.value.model = option.name
    selection.value.providerId = option.providerId
    selection.value.modelId = option.modelId
  }
  modelOpen.value = false
}

const workspacePresets = [
  { id: '', label: '默认工作区' },
  { id: 'my-files', label: '我的文件（沙箱）' },
]

const customWorkspace = ref('')

function pickWorkspace(id: string): void {
  selection.value.workspaceId = id || null
  workspaceOpen.value = false
  customWorkspace.value = ''
}

function createWorkspace(): void {
  const slug = customWorkspace.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  if (!slug) return
  pickWorkspace(slug)
}

function togglePermission(key: 'allowNetwork' | 'allowShell'): void {
  if (selection.value[key]) {
    selection.value[key] = false
    return
  }
  riskKey.value = key
  riskChecked.value = false
  permOpen.value = false
}

function confirmRisk(): void {
  if (!riskKey.value || !riskChecked.value) return
  selection.value[riskKey.value] = true
  riskKey.value = null
  riskChecked.value = false
}

function cancelRisk(): void {
  riskKey.value = null
  riskChecked.value = false
}
/* ---------- 附件上传 ---------- */
async function uploadFiles(files: File[]): Promise<void> {
  for (const file of files) {
    const item: PendingAttachment = {
      id: 'pending-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      filename: file.name,
      progress: 0,
      status: 'uploading',
    }
    pendingAttachments.value = [...pendingAttachments.value, item]
    try {
      const result = await uploadAttachment(file, (percent) => {
        item.progress = percent
      })
      pendingAttachments.value = pendingAttachments.value.filter((row) => row.id !== item.id)
      richRef.value?.insertFileToken({ attachmentId: result.id, filename: result.filename })
    } catch {
      item.status = 'failed'
      ElMessage.error('文件「' + file.name + '」上传失败')
    }
  }
}

function openPicker(kind: 'file' | 'image'): void {
  menuOpen.value = false
  if (kind === 'image') imageInputRef.value?.click()
  else fileInputRef.value?.click()
}

function onFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length > 0) void uploadFiles(files)
}

function removePendingAttachment(id: string): void {
  pendingAttachments.value = pendingAttachments.value.filter((row) => row.id !== id)
}

function onDropFiles(files: File[]): void {
  void uploadFiles(files)
}

/* ---------- 频率与有效期 ---------- */
const isOnce = computed(
  () => schedule.value.freqGroup === 'cycle' && schedule.value.cycleKind === 'once',
)

const freqSummary = computed(() => buildFreqSummary(schedule.value))
const validitySummary = computed(() => buildValiditySummary(schedule.value))

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1)
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1)

/** 星期多选：点击切换，至少保留一天 */
function toggleWeekDay(list: number[], value: number): void {
  const index = list.indexOf(value)
  if (index >= 0) {
    if (list.length === 1) return
    list.splice(index, 1)
  } else {
    list.push(value)
  }
}

/* ---------- 初始化与保存 ---------- */
function applyTask(task: AutomationTask): void {
  title.value = task.title
  selection.value = {
    expertId: task.expertId,
    expertName: task.expertName,
    expertPrompt: '',
    skillIds: [...task.skillIds],
    kbIds: [...task.kbIds],
    mode: task.contextMode,
    model: task.model,
    modelId: task.modelId,
    providerId: task.providerId,
    webSearch: false,
    workspaceId: task.workspaceId,
    allowNetwork: task.allowNetwork,
    allowShell: task.allowShell,
  }
  schedule.value = {
    ...createDefaultSchedule(),
    ...task.schedule,
    weekDays: [...task.schedule.weekDays],
    weekIntervalDays: [...task.schedule.weekIntervalDays],
  }
  parts.value = task.promptParts.map((part) =>
    part.type === 'file'
      ? {
          type: 'file' as const,
          attachmentId: part.attachmentId ?? '',
          filename: part.filename ?? '',
        }
      : { type: 'text' as const, text: part.text ?? '' },
  )
}

/** 回填输入卡内容：文本段与文件标记按原顺序重建 */
async function renderParts(): Promise<void> {
  await nextTick()
  const rich = richRef.value
  if (!rich || !props.task) return
  rich.setParts(parts.value)
  await ensureSkills()
  for (const skillId of selection.value.skillIds) {
    const skill = skills.value.find((item) => item.id === skillId)
    if (skill) rich.insertSkill({ id: skill.id, name: skill.name })
  }
}

function buildDraft(): AutomationTaskDraft {
  const current = schedule.value
  return {
    title: title.value.trim() || promptText.value.slice(0, 18) || '未命名自动化任务',
    promptText: promptText.value,
    promptParts: parts.value.map((part) =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : {
            type: 'file' as const,
            attachmentId: part.attachmentId,
            filename: part.filename,
          },
    ),
    icon: props.task?.icon ?? '⏰',
    source: props.task?.source ?? 'custom',
    templateId: props.task?.templateId ?? null,
    schedule: {
      ...current,
      weekDays: [...current.weekDays],
      weekIntervalDays: [...current.weekIntervalDays],
    },
    model: selection.value.model,
    customModelId: null,
    providerId: selection.value.providerId,
    modelId: selection.value.modelId,
    expertId: selection.value.expertId,
    expertName: selection.value.expertName,
    contextMode: selection.value.mode,
    skillIds: [...selection.value.skillIds],
    kbIds: [...selection.value.kbIds],
    workspaceId: selection.value.workspaceId,
    workspaceName: selection.value.workspaceId,
    allowNetwork: selection.value.allowNetwork,
    allowShell: selection.value.allowShell,
    fullAccess: false,
  }
}

async function submit(): Promise<void> {
  formError.value = ''
  if (!hasPrompt.value) {
    formError.value = '请先填写任务描述 / 提示词'
    return
  }
  if (pendingAttachments.value.some((item) => item.status === 'uploading')) {
    formError.value = '文件正在上传，请稍候'
    return
  }
  saving.value = true
  try {
    const draft = buildDraft()
    if (props.task) await automation.updateTask(props.task.id, draft)
    else await automation.createTask(draft)
    await automation.loadStats()
    ElMessage.success(props.task ? '任务已保存' : '定时任务已创建')
    emit('saved')
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePopups()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (props.task) applyTask(props.task)
  void ensureModels()
  void renderParts()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>
<template>
  <div class="atd-mask" @click.self="emit('close')">
    <div class="atd-card">
      <div class="atd-header">
        <div>
          <p class="atd-title">{{ task ? '编辑自动化' : '新建自动化' }}</p>
          <p class="atd-subtitle">配置提示词与执行频率，到点后自动唤醒智能体执行</p>
        </div>
        <button class="atd-close" title="关闭" @click="emit('close')" aria-label="关闭">
          <X :size="16" />
        </button>
      </div>

      <div class="atd-body">
        <div v-if="popupOpen" class="atd-popover-mask" @click="closePopups" />

        <div class="atd-field">
          <label class="atd-label">任务名称</label>
          <input
            v-model="title"
            type="text"
            class="atd-input"
            placeholder="例如：每日行业快报推送"
          />
        </div>

        <div class="atd-field">
          <label class="atd-label">任务描述 / 提示词</label>
          <div class="atd-prompt">
            <div
              v-if="
                selection.expertName || selection.mode !== 'default' || selection.kbIds.length > 0
              "
              class="atd-chips"
            >
              <span v-if="selection.expertName" class="atd-chip" @click="clearExpert">
                {{ selection.expertName }}
                <X :size="10" />
              </span>
              <span
                v-if="selection.mode !== 'default'"
                class="atd-chip"
                @click="selection.mode = 'default'"
              >
                模式 · {{ modeLabel }}
                <X :size="10" />
              </span>
              <span
                v-if="selection.kbIds.length > 0"
                class="atd-chip"
                @click="selection.kbIds = []"
              >
                知识库 · 已选 {{ selection.kbIds.length }} 个
                <X :size="10" />
              </span>
            </div>

            <div v-if="pendingAttachments.length > 0" class="atd-pending">
              <span
                v-for="item in pendingAttachments"
                :key="item.id"
                class="atd-pending-item"
                :class="{ 'atd-pending-item--failed': item.status === 'failed' }"
              >
                {{ item.filename }}
                <span v-if="item.status === 'uploading'">{{ item.progress }}%</span>
                <X :size="10" @click.stop="removePendingAttachment(item.id)" />
              </span>
            </div>

            <RichInput
              ref="richRef"
              :parts="parts"
              placeholder="描述你希望每次执行的内容… 支持引用文件与技能"
              @update:parts="onPartsUpdate"
              @files="onDropFiles"
            />

            <div class="atd-toolbar">
              <div class="atd-tool-wrap">
                <button
                  class="atd-tool"
                  title="添加文件 / 技能 / 专家 / 知识库 / 模式"
                  @click="openMenu('root')"
                 aria-label="添加文件 / 技能 / 专家 / 知识库 / 模式">
                  <Plus :size="15" />
                </button>
                <div v-if="menuOpen" class="atd-menu">
                  <template v-if="menuPanel === 'root'">
                    <button class="atd-menu-item" @click="menuPanel = 'file'">
                      <FileText :size="14" /><span>添加文件</span>
                    </button>
                    <button class="atd-menu-item" @click="menuPanel = 'mode'">
                      <Zap :size="14" /><span>模式</span>
                    </button>
                    <button class="atd-menu-item" @click="openMenu('expert')">
                      <Bot :size="14" /><span>专家</span>
                    </button>
                    <button class="atd-menu-item" @click="openMenu('skill')">
                      <Sparkles :size="14" /><span>技能</span>
                    </button>
                    <button class="atd-menu-item" @click="openMenu('kb')">
                      <BookOpen :size="14" /><span>知识库</span>
                    </button>
                  </template>

                  <template v-else-if="menuPanel === 'file'">
                    <button class="atd-menu-item" @click="openPicker('file')">
                      <Paperclip :size="14" /><span>上传本地文件</span>
                    </button>
                    <button class="atd-menu-item" @click="openPicker('image')">
                      <ImagePlus :size="14" /><span>上传图片</span>
                    </button>
                  </template>

                  <template v-else-if="menuPanel === 'mode'">
                    <button
                      v-for="option in ['default', 'files', 'knowledge'] as const"
                      :key="option"
                      class="atd-menu-item"
                      @click="pickMode(option)"
                    >
                      <Check :size="14" :class="{ 'atd-hidden': selection.mode !== option }" />
                      <span>{{ CONTEXT_MODE_LABEL[option] }}</span>
                    </button>
                  </template>

                  <template v-else-if="menuPanel === 'expert'">
                    <div class="atd-search">
                      <Search :size="12" />
                      <input v-model="expertSearch" placeholder="搜索专家" />
                    </div>
                    <div class="atd-list">
                      <button
                        v-for="expert in filteredExperts"
                        :key="expert.id"
                        class="atd-menu-item"
                        @click="pickExpert(expert)"
                      >
                        <Check
                          :size="14"
                          :class="{ 'atd-hidden': selection.expertId !== expert.id }"
                        />
                        <span class="atd-ellipsis">{{ expert.name }}</span>
                      </button>
                      <p v-if="filteredExperts.length === 0" class="atd-empty">暂无专家</p>
                    </div>
                  </template>

                  <template v-else-if="menuPanel === 'skill'">
                    <div class="atd-search">
                      <Search :size="12" />
                      <input v-model="skillSearch" placeholder="搜索技能" />
                    </div>
                    <div class="atd-list">
                      <button
                        v-for="skill in filteredSkills"
                        :key="skill.id"
                        class="atd-menu-item"
                        @click="toggleSkill(skill)"
                      >
                        <Check
                          :size="14"
                          :class="{ 'atd-hidden': !selection.skillIds.includes(skill.id) }"
                        />
                        <span class="atd-ellipsis">{{ skill.name }}</span>
                      </button>
                      <p v-if="filteredSkills.length === 0" class="atd-empty">暂无技能</p>
                    </div>
                  </template>

                  <template v-else>
                    <div class="atd-search">
                      <Search :size="12" />
                      <input v-model="kbSearch" placeholder="搜索知识库" />
                    </div>
                    <div class="atd-list">
                      <button
                        v-for="kb in filteredKbs"
                        :key="kb.id"
                        class="atd-menu-item"
                        @click="toggleKb(kb.id)"
                      >
                        <Check
                          :size="14"
                          :class="{ 'atd-hidden': !selection.kbIds.includes(kb.id) }"
                        />
                        <span class="atd-ellipsis">{{ kb.name }}</span>
                      </button>
                      <p v-if="filteredKbs.length === 0" class="atd-empty">暂无知识库</p>
                    </div>
                  </template>
                </div>
              </div>

              <button class="atd-tool" title="上传本地文件" @click="openPicker('file')" aria-label="上传本地文件">
                <Paperclip :size="15" />
              </button>

              <div class="atd-tool-wrap">
                <button class="atd-model-btn" title="选择模型" @click="toggleModelMenu">
                  <Zap :size="12" />
                  <span class="atd-ellipsis">{{ selection.model ?? '默认模型' }}</span>
                </button>
                <div v-if="modelOpen" class="atd-menu atd-menu--right">
                  <button class="atd-menu-item" @click="pickModel()">
                    <Check :size="14" :class="{ 'atd-hidden': Boolean(selection.model) }" />
                    <span>默认模型</span>
                  </button>
                  <div class="atd-list">
                    <button
                      v-for="option in modelOptions"
                      :key="option.providerId + option.modelId"
                      class="atd-menu-item"
                      @click="pickModel(option)"
                    >
                      <Check
                        :size="14"
                        :class="{ 'atd-hidden': selection.model !== option.name }"
                      />
                      <span class="atd-ellipsis">{{ option.name }}</span>
                    </button>
                    <p v-if="modelOptions.length === 0" class="atd-empty">暂无可用模型</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="atd-field">
          <label class="atd-label">执行频率</label>
          <div class="atd-seg">
            <button
              class="atd-seg-btn"
              :class="{ 'atd-seg-btn--active': schedule.freqGroup === 'cycle' }"
              @click="schedule.freqGroup = 'cycle'"
            >
              周期
            </button>
            <button
              class="atd-seg-btn"
              :class="{ 'atd-seg-btn--active': schedule.freqGroup === 'interval' }"
              @click="schedule.freqGroup = 'interval'"
            >
              间隔
            </button>
          </div>

          <template v-if="schedule.freqGroup === 'cycle'">
            <div class="atd-seg atd-seg--sub">
              <button
                v-for="option in CYCLE_OPTIONS"
                :key="option.key"
                class="atd-seg-btn atd-seg-btn--sm"
                :class="{ 'atd-seg-btn--active': schedule.cycleKind === option.key }"
                @click="schedule.cycleKind = option.key"
              >
                {{ option.label }}
              </button>
            </div>
            <div class="atd-freq-row">
              <template v-if="schedule.cycleKind === 'once'">
                <span class="atd-freq-label">日期</span>
                <input v-model="schedule.onceDate" type="date" class="atd-input atd-input--sm" />
                <span class="atd-freq-label">时间</span>
                <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
              </template>
              <template v-else-if="schedule.cycleKind === 'daily'">
                <span class="atd-freq-label">时间</span>
                <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
              </template>
              <template v-else-if="schedule.cycleKind === 'weekly'">
                <span class="atd-freq-label">星期</span>
                <div class="atd-weekdays">
                  <button
                    v-for="day in WEEK_DAYS"
                    :key="day.value"
                    class="atd-weekday"
                    :class="{ 'atd-weekday--active': schedule.weekDays.includes(day.value) }"
                    @click="toggleWeekDay(schedule.weekDays, day.value)"
                  >
                    {{ day.label }}
                  </button>
                </div>
                <span class="atd-freq-label">时间</span>
                <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
              </template>
              <template v-else-if="schedule.cycleKind === 'monthly'">
                <span class="atd-freq-label">每月</span>
                <select v-model.number="schedule.monthDay" class="atd-input atd-input--sm">
                  <option v-for="day in MONTH_DAYS" :key="day" :value="day">{{ day }}</option>
                </select>
                <span class="atd-freq-label">日</span>
                <span class="atd-freq-label">时间</span>
                <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
              </template>
              <template v-else>
                <span class="atd-freq-label">每年</span>
                <select v-model.number="schedule.yearMonth" class="atd-input atd-input--sm">
                  <option v-for="month in MONTHS" :key="month" :value="month">{{ month }}</option>
                </select>
                <span class="atd-freq-label">月</span>
                <select v-model.number="schedule.yearDay" class="atd-input atd-input--sm">
                  <option v-for="day in MONTH_DAYS" :key="day" :value="day">{{ day }}</option>
                </select>
                <span class="atd-freq-label">日</span>
                <span class="atd-freq-label">时间</span>
                <input v-model="schedule.onceTime" type="time" class="atd-input atd-input--sm" />
              </template>
            </div>
          </template>

          <template v-else>
            <div class="atd-seg atd-seg--sub">
              <button
                v-for="option in INTERVAL_OPTIONS"
                :key="option.key"
                class="atd-seg-btn atd-seg-btn--sm"
                :class="{ 'atd-seg-btn--active': schedule.intervalKind === option.key }"
                @click="schedule.intervalKind = option.key"
              >
                {{ option.label }}
              </button>
            </div>
            <div class="atd-freq-row">
              <template v-if="schedule.intervalKind === 'weekly'">
                <span class="atd-freq-label">星期</span>
                <div class="atd-weekdays">
                  <button
                    v-for="day in WEEK_DAYS"
                    :key="day.value"
                    class="atd-weekday"
                    :class="{
                      'atd-weekday--active': schedule.weekIntervalDays.includes(day.value),
                    }"
                    @click="toggleWeekDay(schedule.weekIntervalDays, day.value)"
                  >
                    {{ day.label }}
                  </button>
                </div>
              </template>
              <template v-else>
                <span class="atd-freq-label">每隔</span>
                <input
                  v-model.number="schedule.hourInterval"
                  type="number"
                  min="1"
                  max="24"
                  class="atd-input atd-input--num"
                />
                <span class="atd-freq-label">小时执行 1 次</span>
              </template>
            </div>
          </template>

          <p class="atd-summary">执行计划：{{ freqSummary }}</p>
        </div>

        <div class="atd-field">
          <label class="atd-label">有效期</label>
          <p v-if="isOnce" class="atd-summary">单次任务仅在指定时间执行一次，无需设置有效期。</p>
          <template v-else>
            <div class="atd-seg">
              <button
                class="atd-seg-btn"
                :class="{ 'atd-seg-btn--active': schedule.validityMode === 'forever' }"
                @click="schedule.validityMode = 'forever'"
              >
                长期有效
              </button>
              <button
                class="atd-seg-btn"
                :class="{ 'atd-seg-btn--active': schedule.validityMode === 'range' }"
                @click="schedule.validityMode = 'range'"
              >
                指定时间段
              </button>
            </div>
            <div v-if="schedule.validityMode === 'range'" class="atd-validity">
              <div class="atd-freq-row">
                <span class="atd-freq-label">开始</span>
                <input v-model="schedule.validFrom" type="date" class="atd-input atd-input--sm" />
                <input
                  v-model="schedule.validFromTime"
                  type="time"
                  class="atd-input atd-input--sm"
                />
              </div>
              <div class="atd-freq-row">
                <span class="atd-freq-label">结束</span>
                <input v-model="schedule.validTo" type="date" class="atd-input atd-input--sm" />
                <input v-model="schedule.validToTime" type="time" class="atd-input atd-input--sm" />
              </div>
            </div>
            <p class="atd-summary">有效期：{{ validitySummary }}</p>
          </template>
        </div>

        <div class="atd-field">
          <label class="atd-label">运行环境</label>
          <div class="atd-env-row">
            <div class="atd-tool-wrap">
              <button class="atd-env-btn" @click="toggleWorkspaceMenu">
                <FolderOpen :size="12" />
                {{ selection.workspaceId ? selection.workspaceId : '默认工作区' }}
              </button>
              <div v-if="workspaceOpen" class="atd-menu atd-menu--top">
                <button
                  v-for="item in workspacePresets"
                  :key="item.id || 'default'"
                  class="atd-menu-item"
                  @click="pickWorkspace(item.id)"
                >
                  <Check
                    :size="14"
                    :class="{ 'atd-hidden': (selection.workspaceId ?? '') !== item.id }"
                  />
                  <span>{{ item.label }}</span>
                </button>
                <div class="atd-search">
                  <input
                    v-model="customWorkspace"
                    placeholder="工作区名称（字母/数字/-_）"
                    @keydown.enter.prevent="createWorkspace"
                  />
                </div>
                <button class="atd-menu-item" @click="createWorkspace">
                  <Plus :size="14" /><span>新建并切换</span>
                </button>
              </div>
            </div>

            <div class="atd-tool-wrap">
              <button
                class="atd-env-btn"
                :class="{ 'atd-env-btn--active': selection.allowNetwork || selection.allowShell }"
                @click="togglePermMenu"
              >
                <ShieldCheck :size="12" />
                {{ permissionLabel }}
              </button>
              <div v-if="permOpen" class="atd-menu atd-menu--top">
                <p class="atd-menu-desc">
                  默认权限下仅可读写工作区；开启后智能体可访问外部资源或运行命令，请谨慎使用。
                </p>
                <button class="atd-menu-item" @click="togglePermission('allowNetwork')">
                  <Check :size="14" :class="{ 'atd-hidden': !selection.allowNetwork }" />
                  <span>联网访问</span>
                </button>
                <button class="atd-menu-item" @click="togglePermission('allowShell')">
                  <Check :size="14" :class="{ 'atd-hidden': !selection.allowShell }" />
                  <span>代码执行</span>
                </button>
              </div>
            </div>
          </div>
          <p class="atd-summary">
            模型：{{ selection.model ?? '默认模型' }} · 专家：{{
              selection.expertName ?? '未选择'
            }}
            · 技能：{{ selection.skillIds.length }} 个
          </p>
        </div>

        <p v-if="formError" class="atd-error">{{ formError }}</p>
      </div>

      <div class="atd-footer">
        <button class="atd-btn atd-btn--cancel" @click="emit('close')">取消</button>
        <button class="atd-btn atd-btn--confirm" :disabled="saving || !hasPrompt" @click="submit">
          {{ task ? '保存' : '创建任务' }}
        </button>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        multiple
        hidden
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.py,.java,.csv,.md,.json,.xml,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.bmp"
        @change="onFilesSelected"
      />
      <input
        ref="imageInputRef"
        type="file"
        multiple
        hidden
        accept="image/*"
        @change="onFilesSelected"
      />

      <div v-if="riskKey" class="atd-risk-mask" @click.self="cancelRisk">
        <div class="atd-risk">
          <p class="atd-risk-title">开启高风险权限</p>
          <p class="atd-risk-text">
            {{
              riskKey === 'allowNetwork'
                ? '允许智能体在该任务中访问外部网络资源'
                : '允许智能体在该任务中执行命令与代码'
            }}，可能带来数据外泄或环境变更风险。
          </p>
          <label class="atd-risk-check">
            <input v-model="riskChecked" type="checkbox" />
            <span>我已了解风险，并确认开启</span>
          </label>
          <div class="atd-risk-actions">
            <button class="atd-btn atd-btn--cancel" @click="cancelRisk">取消</button>
            <button class="atd-btn atd-btn--confirm" :disabled="!riskChecked" @click="confirmRisk">
              确认开启
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.atd-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--color-overlay);
  backdrop-filter: blur(3px);
}

.atd-card {
  position: relative;
  width: 100%;
  max-width: 640px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  background: var(--color-modal-bg);
  box-shadow: var(--shadow-modal);
}

.atd-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.atd-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.atd-subtitle {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.atd-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-muted);
  cursor: pointer;
}

.atd-close:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.atd-body {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px;
  overflow-y: auto;
}

.atd-popover-mask {
  position: absolute;
  inset: 0;
  z-index: 30;
}

.atd-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.atd-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.atd-input {
  padding: 8px 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  outline: none;
}

.atd-input:focus {
  border-color: var(--accent-primary);
}

.atd-input--sm {
  padding: 6px 8px;
  width: auto;
  font-size: var(--font-size-xs);
}

.atd-input--num {
  width: 72px;
}

.atd-prompt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 6px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-xl);
  background: var(--surface-secondary);
}

.atd-chips,
.atd-pending {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 14px;
}

.atd-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: var(--surface-card);
  color: var(--accent-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.atd-pending-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px dashed var(--border-medium);
  border-radius: var(--radius-full);
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
}

.atd-pending-item--failed {
  border-color: #ef4444;
  color: #ef4444;
}

.atd-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
}

.atd-tool-wrap {
  position: relative;
}

.atd-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
}

.atd-tool:hover {
  background: rgba(59, 130, 246, 0.12);
  color: var(--foreground-primary);
}

.atd-model-btn,
.atd-env-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.atd-model-btn:hover,
.atd-env-btn:hover {
  background: var(--surface-card);
  color: var(--foreground-primary);
}

.atd-env-btn--active {
  color: var(--accent-primary);
}

.atd-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  min-width: 200px;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-lg);
  background: var(--surface-card);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.atd-menu--right {
  left: auto;
  right: 0;
}

.atd-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.atd-menu-item:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.atd-menu-desc {
  margin: 2px 6px 6px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
.atd-hidden {
  visibility: hidden;
}

.atd-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.atd-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 200px;
  overflow-y: auto;
}

.atd-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-secondary);
  color: var(--foreground-muted);
}

.atd-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--foreground-primary);
  font-size: var(--font-size-xs);
}

.atd-empty {
  margin: 0;
  padding: 10px;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.atd-seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  align-self: flex-start;
}

.atd-seg--sub {
  margin-top: 2px;
}

.atd-seg-btn {
  padding: 5px 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.15s ease;
}

.atd-seg-btn--sm {
  padding: 4px 10px;
}

.atd-seg-btn:hover {
  color: var(--foreground-primary);
}

.atd-seg-btn--active {
  background: var(--accent-primary);
  color: #fff;
}

.atd-freq-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.atd-freq-label {
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.atd-weekdays {
  display: flex;
  gap: 4px;
}

.atd-weekday {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--foreground-muted);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.atd-weekday--active {
  border-color: var(--accent-primary);
  background: var(--accent-primary);
  color: #fff;
}

.atd-summary {
  margin-top: 6px;
  font-size: var(--font-size-xs);
  color: var(--foreground-muted);
}

.atd-validity {
  margin-top: 8px;
}

.atd-env-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.atd-error {
  margin: 0;
  color: #f87171;
  font-size: var(--font-size-xs);
}

.atd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border-subtle);
}

.atd-btn {
  padding: 8px 18px;
  border: none;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.atd-btn--cancel {
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
}

.atd-btn--confirm {
  background: var(--accent-primary);
  color: #fff;
}

.atd-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.atd-risk-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xl);
  background: rgba(15, 23, 42, 0.45);
  z-index: 60;
}

.atd-risk {
  width: 380px;
  padding: 18px 20px 16px;
  border-radius: var(--radius-xl);
  background: var(--surface-card);
  box-shadow: var(--shadow-modal);
}

.atd-risk-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
}

.atd-risk-text {
  margin: 8px 0 12px;
  font-size: var(--font-size-sm);
  line-height: 1.7;
  color: var(--foreground-secondary);
}

.atd-risk-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-secondary);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.atd-risk-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
