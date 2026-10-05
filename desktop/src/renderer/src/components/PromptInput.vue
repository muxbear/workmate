<script lang="ts">
import type { Mode as CatalogMode } from '@store/catalog'
import type { MessagePart as PromptPart } from '../../../shared/contracts'

/** 发送时交给父级的输入快照（正文 + 附件 + 选中项） */
export interface PromptPayload {
  /** 保序消息部件：文本段 + 文件段 */
  parts: PromptPart[]
  /** 纯文本内容（不含文件路径） */
  text: string
  /** 选中的模型名 */
  model: string
  /** 自定义模型 id（内置模型为 undefined） */
  customModelId?: string
  /** 选中的专家（无则 null） */
  expertId: string | null
  expertName: string | null
  /** 「+」菜单选中的模式 */
  mode: CatalogMode
  /** 输入框中引用的技能 id 列表 */
  skillIds: string[]
  /** 引用文件数量 */
  fileCount: number
  /** 选中的工作空间 */
  workspaceId: string | null
  workspaceName: string | null
  /** 是否开启「允许完全访问」 */
  fullAccess: boolean
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { showToast } from '@renderer/composables/useToast'
import { createFileToken, serializeInput, useRichTokens } from '@renderer/composables/useRichTokens'
import { useFileAttach } from '@renderer/composables/useFileAttach'
import { createHoverMenu } from '@renderer/composables/hoverMenu'
import { useCatalogStore, type CatalogTab, type Mode } from '@store/catalog'
import { useWorkspaceStore } from '@store/workspace'
import { useModelStore } from '@store/models'
import { useSettingsStore } from '@store/settings'
import PlusMenu from './PlusMenu.vue'
import ModelSelect from './ModelSelect.vue'
import PermissionMenu from './PermissionMenu.vue'
import WorkspaceCreateModal from './WorkspaceCreateModal.vue'
import type { MessagePart } from '../../../shared/contracts'

/**
 * 任务提示词输入卡（PromptInput）
 *
 * 功能与「新建任务」页的消息输入框保持一致：
 * - contenteditable 富输入：技能 token（/技能）、文件 token（本地文件 / 拖拽文件）
 * - 「+」菜单（添加文件 / 模式 / 专家 / 技能 / 连接器）、AI 改写润色
 * - 模型选择、工作空间选择、权限开关、发送按钮
 * 不含「新建任务」页输入框上方的分类行（文档处理 / 深度研究 等）。
 */

const settingsStore = useSettingsStore()

const props = withDefaults(
  defineProps<{
    /** 输入框占位文案 */
    placeholder?: string
    /** 发送按钮的无障碍标题 */
    submitLabel?: string
    /** 紧凑样式（对话态输入框） */
    compact?: boolean
    /** 流式输出中：发送按钮变停止按钮 */
    streaming?: boolean
    /** 模型下拉展开方向（弹窗内空间不足时向下展开） */
    menuPlacement?: 'up' | 'down'
    /** 输入区最小高度（px） */
    minHeight?: number
    /** 输入区最大高度（px，0 表示随内容增长） */
    maxHeight?: number
    /** 卸载时是否清掉未提交草稿的技能勾选 */
    cleanupOnUnmount?: boolean
  }>(),
  {
    placeholder: '描述希望 KE-WORK 执行的内容…  @ 引用文件，/ 调用技能',
    submitLabel: '发送',
    compact: false,
    streaming: false,
    menuPlacement: 'up',
    minHeight: 84,
    maxHeight: 0,
    cleanupOnUnmount: false
  }
)

/** 占位文案中的内置品牌名替换为「系统设置 → 系统标识」中的系统名称 */
const brandPlaceholder = computed(() =>
  props.placeholder.replace('KE-WORK', settingsStore.systemName)
)

/** 草稿文本（与父级双向绑定；父级发送失败回填也走这里） */
const taskInput = defineModel<string>('text', { default: '' })
/** 当前选中的模型（父级发送 / 重新生成时读取） */
const model = defineModel<string>('model', { default: 'Auto' })

const emit = defineEmits<{
  submit: [payload: PromptPayload]
  stop: []
  'update:hasContent': [value: boolean]
  navigate: [tab: CatalogTab]
}>()

const catalog = useCatalogStore()
const workspaceStore = useWorkspaceStore()
const modelStore = useModelStore()

// ── State ──
const inputRef = ref<HTMLElement | null>(null)
const showInputPlusMenu = ref(false)
const polishing = ref(false)

/** 输入框是否有内容（正文 / 技能 token / 文件 token），供父级控制提交按钮状态 */
const hasContent = computed(() => taskInput.value.trim().length > 0)
watch(hasContent, (v) => emit('update:hasContent', v), { immediate: true })

/** 当前输入框元素 */
const getInputEl = (): HTMLElement | null => inputRef.value

/** 富输入 token 工具（序列化 / 光标处插入 / 移除 —— R6 外提至 composables/useRichTokens） */
const richTokens = useRichTokens({
  syncText: (text) => {
    taskInput.value = text
  }
})


/** 菜单选技能：切 store 勾选（真相源）+ 同步 DOM（插入或移除 token） */
const onSelectSkillToken = (id: string): void => {
  const skill = catalog.skillItems.find((s) => s.id === id)
  const el = getInputEl()
  if (!skill || !el) return
  const willSelect = !catalog.selectedSkillIds.includes(id)
  catalog.toggleSkill(id)
  if (willSelect) richTokens.insertSkillTokenAtCaret(el, skill)
  else richTokens.removeSkillTokenFromDom(el, id)
}

// ── 文件附件：选中即时校验 + 拖拽入框（R6 外提至 composables/useFileAttach） ──
const {
  inputDragging,
  onSelectFiles,
  onInputDragEnter,
  onInputDragOver,
  onInputDragLeave,
  onInputDrop
} = useFileAttach({
  getInputEl,
  insertFileToken: (el, path) => richTokens.insertFileTokenAtCaret(el, path),
  notify: showToast
})

/** 点击「AI 改写润色」：校验 → 主进程调 LLM → 改写结果替换输入内容（含 token 时拒绝） */
const onPolishClick = async (): Promise<void> => {
  if (polishing.value) return
  const el = getInputEl()
  if (!el) return
  const raw = el.innerText.trim()
  if (!raw) {
    showToast('请先输入要改写的内容')
    return
  }
  if (el.querySelector('.skill-token, .file-token')) {
    showToast('改写仅支持纯文本，请先移除文件或技能标记')
    return
  }
  polishing.value = true
  try {
    const res = await window.api.polishText(raw)
    if (!res.success || res.data === undefined) {
      throw new Error(res.error || '改写失败')
    }
    // 改写结果替换输入内容（textContent 保留换行，white-space: pre-wrap 直接渲染）
    el.textContent = res.data
    taskInput.value = el.innerText
    // 光标移到末尾并保持焦点（改写后即可继续输入或提交）
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel?.removeAllRanges()
    sel?.addRange(range)
    el.focus()
  } catch (err) {
    showToast(err instanceof Error ? err.message : '改写失败，请重试')
  } finally {
    polishing.value = false
  }
}

/** 点击输入框内 token → 删除（技能 token 同步取消勾选；hover 变 × 由 CSS 实现）；普通点击不拦截 */
const onInputClick = (e: MouseEvent): void => {
  const el = getInputEl()
  if (!el) return
  const token = (e.target as HTMLElement).closest<HTMLElement>('.skill-token, .file-token')
  if (!token) return
  e.preventDefault()
  const prevSibling = token.previousSibling
  if (token.classList.contains('skill-token')) {
    const skillId = token.dataset.skillId
    if (skillId) catalog.toggleSkill(skillId) // 移除勾选，菜单勾选态同步消失
  }
  token.remove()
  taskInput.value = el.innerText
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  if (prevSibling) {
    range.setStartAfter(prevSibling)
    range.collapse(true)
  } else {
    range.selectNodeContents(el)
    range.collapse(true)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

/** 输入事件：同步快照 + 与 store 勾选对账（退格整删 token 后清理过期勾选） */
const onInputSync = (): void => {
  const el = getInputEl()
  if (!el) return
  // 用户清空内容后浏览器可能残留 <br>，清掉让 :empty 占位符恢复
  if (el.innerText.trim() === '' && el.innerHTML !== '' && !el.querySelector('.file-token')) {
    el.innerHTML = ''
  }
  taskInput.value = el.innerText
  // 对账：DOM 中不存在的 token 从勾选中移除（退格键 / 选择删除路径）
  const domIds = new Set(
    Array.from(el.querySelectorAll<HTMLElement>('.skill-token')).map((t) => t.dataset.skillId ?? '')
  )
  for (const id of [...catalog.selectedSkillIds]) {
    if (!domIds.has(id)) catalog.toggleSkill(id)
  }
}

// ── 「+」菜单选中状态展示 ──
const MODE_LABELS: Record<Mode, string> = {
  default: '默认',
  local: '本地文件',
  knowledge: '知识库'
}

interface SelectionChip {
  key: string
  label: string
  kind: 'mode'
}

/** 输入卡左上角 chips：模式（非默认），文件为输入框内联 token，不再显示 chips */
const selectionChips = computed<SelectionChip[]>(() => {
  if (catalog.mode === 'default') return []
  return [{ key: 'mode', label: '模式 · ' + MODE_LABELS[catalog.mode], kind: 'mode' }]
})

/** 点击 chip 移除对应选择（模式回默认） */
const removeChip = (chip: SelectionChip): void => {
  if (chip.kind === 'mode') catalog.setMode('default')
}

/** 移除专家选择（输入框不含提示词，仅取消选择状态） */
const removeExpert = (): void => {
  catalog.clearExpert()
}

/** 菜单内导航（专家 / 技能 / 连接器页面）由父级决定是否响应 */
const onPlusNavigate = (tab: CatalogTab): void => {
  showInputPlusMenu.value = false
  emit('navigate', tab)
}

// ── 模型选择（R6 外提至 ModelSelect 组件；本页保留双向绑定与发送时关闭） ──
/** 当前选中的自定义模型 id（内置模型为 null） */
const selectedCustomId = defineModel<string | null>('customModelId', { default: null })
const modelSelectRef = ref<InstanceType<typeof ModelSelect> | null>(null)

/** 「+」菜单 hover 控制器（模型下拉的控制器随组件外提，见 ModelSelect） */
const plusMenuHover = createHoverMenu(showInputPlusMenu)

// ── Workspace selector 状态 ──
const wsMenuOpen = ref(false)
const showCreateModal = ref(false)

/** 选中列表中的工作空间 */
const pickWorkspace = (ws: { id: string }): void => {
  workspaceStore.select(ws.id)
  wsMenuOpen.value = false
}

/** 打开本地文件夹作为工作空间 */
const pickExternal = async (): Promise<void> => {
  wsMenuOpen.value = false
  await workspaceStore.selectExternal()
}

/** 使用默认工作空间（系统设置配置的目录，未选择任何空间时的兜底） */
const pickDefault = async (): Promise<void> => {
  wsMenuOpen.value = false
  await workspaceStore.useDefault()
}

/** 打开「新建工作空间」弹窗（输入重置由 WorkspaceCreateModal 在打开时自理） */
const openCreateModal = (): void => {
  wsMenuOpen.value = false
  showCreateModal.value = true
}

// ── 允许完全访问（PermissionMenu 的 v-model；渲染层本地状态，localStorage 持久化） ──
const FULL_ACCESS_KEY = 'ke-work.full-access'
const fullAccess = ref(localStorage.getItem(FULL_ACCESS_KEY) === '1')

watch(fullAccess, (v) => {
  localStorage.setItem(FULL_ACCESS_KEY, v ? '1' : '0')
})

// ── 轻量提示：全局 toast（composables/useToast，由 App 的 ToastHost 渲染） ──

// ── 提交 ──
/** 组装输入快照（正文 + 文件段 + 选中模型 / 专家 / 模式 / 工作空间 / 权限） */
const buildPayload = (): PromptPayload => {
  const el = getInputEl()
  const parts = el ? serializeInput(el) : [{ type: 'text' as const, text: taskInput.value }]
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim()
  return {
    parts,
    text,
    model: model.value,
    customModelId: selectedCustomId.value ?? undefined,
    expertId: catalog.selectedExpert?.id ?? null,
    expertName: catalog.selectedExpert?.name ?? null,
    mode: catalog.mode,
    skillIds: [...catalog.selectedSkillIds],
    fileCount: parts.filter((p) => p.type === 'file').length,
    workspaceId: workspaceStore.currentId,
    workspaceName: workspaceStore.currentWorkspace?.name ?? null,
    fullAccess: fullAccess.value
  }
}

/** 点击发送按钮或回车：内容为空时不提交 */
const onSend = (): void => {
  const payload = buildPayload()
  const hasBody = payload.text.length > 0 || payload.parts.some((p) => p.type === 'file')
  if (!hasBody) return
  modelSelectRef.value?.close()
  showInputPlusMenu.value = false
  emit('submit', payload)
}

/** 清空输入框（正文 + 技能 / 文件 token + 技能勾选 + 专家提示词） */
/** 用消息部件重建输入框内容（编辑任务时回填文本与文件 token） */
const setParts = (parts: MessagePart[]): void => {
  const el = getInputEl()
  if (!el) return
  el.textContent = ''
  for (const part of parts) {
    if (part.type === 'text') {
      el.appendChild(document.createTextNode(part.text))
    } else if (part.type === 'file') {
      el.appendChild(createFileToken(part.path))
    }
  }
  taskInput.value = el.innerText
}

/** 清空输入框（正文 + 文件 / 技能 token + 技能勾选；保留专家与模式选择） */
const clear = (): void => {
  const el = getInputEl()
  if (el) el.textContent = ''
  taskInput.value = ''
  catalog.clearSkills()
}

/** 外部写回文本（父级发送失败回填等） */
const setText = (value: string): void => {
  const el = getInputEl()
  if (el) el.textContent = value
  taskInput.value = value
}

/** 聚焦输入框（弹窗打开后可直接输入） */
const focus = (): void => {
  inputRef.value?.focus()
}

defineExpose({ clear, setText, setParts, focus, buildPayload })

// ── 点击外部关闭菜单 ──
/** 父级改写草稿（发送后清空 / 失败回填）时同步 DOM；带 token 时不打断用户输入 */
watch(taskInput, (value) => {
  const el = inputRef.value
  if (!el) return
  if (el.querySelector('.skill-token, .file-token')) return
  if (el.innerText !== value) el.textContent = value
})

/** 输入区高度：页面随内容增长，弹窗内限制最大高度 */
const textareaStyle = computed(() => {
  const style: Record<string, string> = { minHeight: props.minHeight + 'px' }
  if (props.maxHeight > 0) style.maxHeight = props.maxHeight + 'px'
  return style
})

const handleDocumentClick = (e: MouseEvent): void => {
  const target = e.target as HTMLElement
  if (!target.closest('[data-plus-menu-trigger]') && !target.closest('.plus-menu')) {
    showInputPlusMenu.value = false
  }
  if (!target.closest('[data-workspace-menu-trigger]') && !target.closest('.workspace-menu')) {
    wsMenuOpen.value = false
  }
  // 权限菜单的点击外部关闭由 PermissionMenu 组件自持（R6 外提）
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
  // 自定义模型列表（设置页新增后下拉同步刷新；失败静默保留旧值）
  void modelStore.load()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentClick)
  // 卸载时丢弃未提交草稿的技能勾选，避免污染下一次挂载（弹窗 / 欢迎态输入框不复用）
  if (props.cleanupOnUnmount && taskInput.value.trim()) catalog.clearSkills()
})
</script>

<template>
  <div class="prompt-input">
    <!-- 输入卡 -->
    <div :class="compact ? 'chat-input-card' : 'input-card'">
      <div
        ref="inputRef"
        class="task-textarea"
        :class="[
          { 'task-textarea--dragging': inputDragging },
          { 'task-textarea--compact': compact }
        ]"
        contenteditable="true"
        :data-placeholder="brandPlaceholder"
        :style="textareaStyle"
        @input="onInputSync"
        @click="onInputClick"
        @keydown.enter.exact.prevent="onSend"
        @dragenter="onInputDragEnter"
        @dragover="onInputDragOver"
        @dragleave="onInputDragLeave"
        @drop="onInputDrop"
      ></div>
      <div
        v-if="selectionChips.length"
        :class="['selection-chips', { 'selection-chips--compact': compact }]"
      >
        <span
          v-for="chip in selectionChips"
          :key="chip.key"
          class="selection-chip"
          @click="removeChip(chip)"
        >
          <svg
            class="selection-chip-del"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          <span class="selection-chip-name">{{ chip.label }}</span>
        </span>
      </div>
      <div :class="['input-toolbar', { 'input-toolbar--compact': compact }]">
        <button
          class="toolbar-btn"
          data-plus-menu-trigger
          title="添加文件 / 专家 / 技能 / 连接器"
          @mouseenter="plusMenuHover.open"
          @mouseleave="plusMenuHover.scheduleClose"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div v-if="catalog.selectedExpert" class="expert-chip" @click="removeExpert">
          <span class="expert-chip-avatar" :style="{ background: catalog.selectedExpert.color }">
            <span class="expert-chip-avatar-text">{{ catalog.selectedExpert.initials }}</span>
            <svg
              class="expert-chip-avatar-del"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
          <span class="expert-chip-name">{{ catalog.selectedExpert.name }}</span>
        </div>
        <button
          class="toolbar-btn"
          :class="{ 'toolbar-btn--polishing': polishing }"
          :disabled="polishing"
          title="AI 改写润色"
          @click="onPolishClick"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 2L13 7H5L9 2Z" fill="#0891b2" opacity="0.7" />
            <path d="M9 16L13 11H5L9 16Z" fill="#0891b2" opacity="0.9" />
            <path d="M2 9L7 5V13L2 9Z" fill="#06b6d4" opacity="0.7" />
            <path d="M16 9L11 5V13L16 9Z" fill="#06b6d4" opacity="0.9" />
          </svg>
        </button>
        <div class="toolbar-spacer"></div>
        <!-- 模型选择（R6 外提组件：hover 开合 + 内置/自定义分组） -->
        <ModelSelect
          ref="modelSelectRef"
          v-model="model"
          v-model:custom-model-id="selectedCustomId"
          :compact="compact"
          :menu-placement="menuPlacement"
        />
        <button class="toolbar-btn" title="语音输入">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>
        <!-- 发送按钮 -->
        <button
          v-if="!streaming"
          class="send-btn"
          :class="{ 'send-btn--active': hasContent }"
          :title="submitLabel"
          @click="onSend"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
        <button v-else class="send-btn send-btn--stop" :title="'停止生成'" @click="emit('stop')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
        <!-- 「+」菜单 -->
        <Transition name="plus-menu-slide">
          <PlusMenu
            v-if="showInputPlusMenu"
            @mouseenter="plusMenuHover.cancelClose"
            @mouseleave="plusMenuHover.closeNow"
            @select-skill="onSelectSkillToken"
            @select-files="onSelectFiles"
            @close="showInputPlusMenu = false"
            @navigate="onPlusNavigate"
          />
        </Transition>
      </div>
      <div class="input-footer">
        <div class="workspace-selector">
          <button
            class="footer-action"
            data-workspace-menu-trigger
            @click="wsMenuOpen = !wsMenuOpen"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
            </svg>
            {{ workspaceStore.currentWorkspace?.name ?? '选择工作空间' }}
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Transition name="plus-menu-slide">
            <div v-if="wsMenuOpen" class="workspace-menu" @click.stop>
              <div class="ws-search">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  v-model="workspaceStore.query"
                  type="text"
                  placeholder="搜索工作空间"
                  class="ws-search-input"
                />
              </div>
              <div class="ws-list">
                <button
                  v-for="ws in workspaceStore.filteredWorkspaces"
                  :key="ws.id"
                  class="ws-item"
                  @click="pickWorkspace(ws)"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="ws-item-icon"
                  >
                    <path
                      d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                    />
                  </svg>
                  <span class="ws-item-name">{{ ws.name }}</span>
                  <svg
                    v-if="ws.id === workspaceStore.currentId"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    class="ws-item-check"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
                <p v-if="workspaceStore.filteredWorkspaces.length === 0" class="ws-empty">
                  无匹配的工作空间
                </p>
              </div>
              <div class="ws-divider"></div>
              <button class="ws-item" @click="openCreateModal">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="ws-item-icon"
                >
                  <path
                    d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                  />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
                <span class="ws-item-name">新建工作空间</span>
              </button>
              <button class="ws-item" @click="pickExternal">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="ws-item-icon"
                >
                  <path
                    d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                  />
                  <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                <span class="ws-item-name">打开本地文件夹</span>
              </button>
              <button class="ws-item" @click="pickDefault">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="ws-item-icon"
                >
                  <polygon
                    points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
                  />
                </svg>
                <span class="ws-item-name">默认工作空间</span>
              </button>
            </div>
          </Transition>
        </div>
        <PermissionMenu v-model="fullAccess" />
      </div>
    </div>
    <!-- 新建工作空间弹窗（R6 外提组件；允许完全访问的确认弹窗在 PermissionMenu 内） -->
    <WorkspaceCreateModal v-model="showCreateModal" />
  </div>
</template>

<style scoped>
/*
  输入卡（与「新建任务」页消息输入框同款）
  注意：技能 / 文件 token 由 createElement 动态创建，无 scoped data-v 属性，必须用 :deep()
*/
.prompt-input {
  position: relative;
  width: 100%;
}

/* 欢迎态输入卡：与「新建任务」页一致，居中限宽 720px */
.input-card {
  position: relative;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  border-radius: 16px;
  border: 1.5px solid var(--kw-color-border-brand);
  box-shadow: 0 4px 24px rgba(8, 145, 178, 0.08);
  background: var(--kw-color-surface);
}

/* 对话态输入卡：宽度由外层 .chat-input-bar 限制 */
.chat-input-card {
  position: relative;
  width: 100%;
  border-radius: 16px;
  border: 1.5px solid var(--kw-color-border-brand);
  box-shadow: 0 2px 12px rgba(8, 145, 178, 0.06);
  background: var(--kw-color-surface);
}

.task-textarea {
  width: 100%;
  padding: 16px 16px 8px;
  border: none;
  background: transparent;
  outline: none;
  resize: none;
  font-size: 14px;
  font-family: inherit;
  color: #1e293b;
  box-sizing: border-box;
  min-height: 84px;
  line-height: 1.6;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 拖拽文件悬停输入框：虚线高亮提示可放置 */
.task-textarea--dragging {
  outline: 2px dashed #0891b2;
  outline-offset: -2px;
  border-radius: 8px;
  background: var(--kw-color-brand-hover);
}

.task-textarea:empty::before {
  content: attr(data-placeholder);
  color: var(--kw-color-text-faint);
  pointer-events: none;
}

/* 工具栏 */
.input-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px 12px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.toolbar-btn:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-text-muted);
}

.toolbar-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* AI 改写润色：请求中转圈 */
.toolbar-btn--polishing svg {
  animation: polish-spin 0.8s linear infinite;
}

@keyframes polish-spin {
  to {
    transform: rotate(360deg);
  }
}

.toolbar-spacer {
  flex: 1;
}

/* 模型选择 */
/* 发送按钮 */
.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: #e5e7eb;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition:
    transform 0.1s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.send-btn--active {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 8px rgba(8, 145, 178, 0.35);
}

.send-btn:active {
  transform: scale(0.9);
}

/* 流式输出中：停止生成 */
.send-btn--stop {
  background: var(--kw-color-danger);
  color: var(--kw-color-on-accent);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
}

.send-btn--stop:hover {
  background: var(--kw-color-danger-strong);
}

/* 输入卡底部 */
.input-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 10px;
  border-top: 1px solid var(--kw-color-border-brand);
}

/* 选中项 chips（输入卡左上角：模式） */
.selection-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 4px;
}

.selection-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 999px;
  background: var(--kw-color-brand-hover);
  color: var(--kw-color-brand-strong);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.selection-chip:hover {
  background: var(--kw-color-brand-soft);
}

.selection-chip-del {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.selection-chip:hover .selection-chip-del {
  opacity: 1;
}

.selection-chip-name {
  white-space: nowrap;
}

/* 专家 chip（工具栏「+」右侧，hover 头像变删除图标） */
.expert-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid rgba(139, 92, 246, 0.25);
  border-radius: 999px;
  background: rgba(139, 92, 246, 0.08);
  color: #7c3aed;
  font-size: 11px;
  cursor: pointer;
  max-width: 160px;
  transition: background-color 0.15s ease;
}

.expert-chip:hover {
  background: rgba(139, 92, 246, 0.14);
}

.expert-chip-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.expert-chip-avatar {
  position: relative;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--kw-color-on-accent);
  font-size: 8px;
  font-weight: 700;
  flex-shrink: 0;
}

.expert-chip-avatar-text {
  transition: opacity 0.15s ease;
}

.expert-chip-avatar-del {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.expert-chip:hover .expert-chip-avatar-text {
  opacity: 0;
}

.expert-chip:hover .expert-chip-avatar-del {
  opacity: 1;
}

/* 技能 token（contenteditable 输入框内：图标 + 名称，hover 图标变删除） */
:deep(.skill-token) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  margin: 0 1px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 999px;
  background: var(--kw-color-brand-hover);
  cursor: pointer;
  vertical-align: middle;
  white-space: nowrap;
}

:deep(.skill-token-icon) {
  position: relative;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

:deep(.skill-token-icon svg) {
  transition: opacity 0.15s ease;
}

:deep(.skill-token-del) {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
}

:deep(.skill-token:hover .skill-token-icon svg:first-child) {
  opacity: 0;
}

:deep(.skill-token:hover .skill-token-del) {
  opacity: 1;
}

:deep(.skill-token-name) {
  font-size: 12px;
  color: var(--kw-color-brand-strong);
  white-space: nowrap;
}

/* 文件 token（contenteditable 输入框内：图标 + 文件名，hover 图标变删除，title 提示绝对路径） */
:deep(.file-token) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  margin: 0 1px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 999px;
  background: var(--kw-color-brand-hover);
  cursor: pointer;
  vertical-align: middle;
  white-space: nowrap;
}

:deep(.file-token-icon) {
  position: relative;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--kw-color-brand-strong);
  flex-shrink: 0;
}

:deep(.file-token-icon svg) {
  transition: opacity 0.15s ease;
}

:deep(.file-token-del) {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
}

:deep(.file-token:hover .file-token-icon svg:first-child) {
  opacity: 0;
}

:deep(.file-token:hover .file-token-del) {
  opacity: 1;
}

:deep(.file-token-name) {
  font-size: 12px;
  color: var(--kw-color-brand-strong);
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 工作空间选择 */
.workspace-selector {
  position: relative;
}

.workspace-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 260px;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border);
  border-radius: 10px;
  box-shadow:
    0 -2px 16px rgba(0, 0, 0, 0.1),
    0 4px 20px rgba(0, 0, 0, 0.08);
  padding: 6px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ws-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--kw-color-brand-hover);
  border: 1px solid var(--kw-color-border-brand);
  color: var(--kw-color-text-faint);
  margin-bottom: 4px;
}

.ws-search-input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  min-width: 0;
}

.ws-search-input::placeholder {
  color: var(--kw-color-text-faint);
}

.ws-list {
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ws-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 7px;
  color: #1e293b;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease;
}

.ws-item:hover {
  background: #f1f5f9;
}

.ws-item-icon {
  flex-shrink: 0;
  color: var(--kw-color-text-subtle);
}

.ws-item-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ws-item-check {
  flex-shrink: 0;
  color: var(--kw-color-brand);
}

.ws-empty {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
  text-align: center;
}

.ws-divider {
  margin: 4px 6px;
  border-top: 1px solid #eef2f7;
}

/* 紧凑变体（对话态） */
.task-textarea--compact {
  padding: 12px 12px 4px;
  min-height: 60px;
}

.input-toolbar--compact {
  padding: 0 8px 10px;
}

.selection-chips--compact {
  padding: 0 12px 2px;
}

</style>
