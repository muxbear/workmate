<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useCatalogStore, type CatalogTab, type Mode, type SkillItem } from '@store/catalog'
import { useWorkspaceStore } from '@store/workspace'
import { useModelStore } from '@store/models'
import PlusMenu from './PlusMenu.vue'
import type { MessagePart } from '../../../preload/index.d'

/**
 * 任务提示词输入卡（PromptInput）
 *
 * 功能与「新建任务」页的消息输入框保持一致：
 * - contenteditable 富输入：技能 token（/技能）、文件 token（本地文件 / 拖拽文件）
 * - 「+」菜单（添加文件 / 模式 / 专家 / 技能 / 连接器）、AI 改写润色
 * - 模型选择、工作空间选择、权限开关、发送按钮
 * 不含「新建任务」页输入框上方的分类行（文档处理 / 金融服务 等）。
 */

withDefaults(
  defineProps<{
    /** 输入框占位文案 */
    placeholder?: string
    /** 发送按钮的无障碍标题 */
    submitLabel?: string
  }>(),
  {
    placeholder: '描述希望 KE-WORK 执行的内容…  @ 引用文件，/ 调用技能',
    submitLabel: '发送'
  }
)

/** 发送时交给父级的输入快照（正文 + 附件 + 选中项） */
interface PromptPayload {
  /** 保序消息部件：文本段 + 文件段 */
  parts: MessagePart[]
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
  mode: Mode
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

const emit = defineEmits<{
  submit: [payload: PromptPayload]
  'update:hasContent': [value: boolean]
  navigate: [tab: CatalogTab]
}>()

const catalog = useCatalogStore()
const workspaceStore = useWorkspaceStore()
const modelStore = useModelStore()

// ── State ──
const inputRef = ref<HTMLElement | null>(null)
const taskInput = ref('')
const model = ref('Auto')
const modelOpen = ref(false)
const showInputPlusMenu = ref(false)
const polishing = ref(false)

/** 输入框是否有内容（正文 / 技能 token / 文件 token），供父级控制提交按钮状态 */
const hasContent = computed(() => taskInput.value.trim().length > 0)
watch(hasContent, (v) => emit('update:hasContent', v), { immediate: true })

/** 当前输入框元素 */
const getInputEl = (): HTMLElement | null => inputRef.value

/** 相邻文本段合并（减少 parts 数量；文件段自然分隔） */
const pushTextPart = (parts: MessagePart[], text: string): void => {
  const last = parts[parts.length - 1]
  if (last && last.type === 'text') last.text += text
  else parts.push({ type: 'text', text })
}

/** 序列化输入框 DOM → 保序消息部件：文本节点原样；技能 token → /技能名；文件 token → {type:'file',path} */
const serializeInput = (el: HTMLElement): MessagePart[] => {
  const parts: MessagePart[] = []
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? ''
      if (t) pushTextPart(parts, t)
    } else if (node instanceof HTMLElement && node.classList.contains('skill-token')) {
      pushTextPart(parts, '/' + (node.dataset.name ?? node.textContent ?? ''))
    } else if (node instanceof HTMLElement && node.classList.contains('file-token')) {
      const path = node.dataset.path
      if (path) parts.push({ type: 'file', path })
    } else if (node.nodeName === 'BR') {
      pushTextPart(parts, '\n')
    } else if (node instanceof HTMLElement) {
      const t = node.textContent ?? ''
      if (t) pushTextPart(parts, t)
    }
  }
  return parts
}

/** 在光标处插入技能 token（无有效光标时追加到末尾），光标移到 token 后 */
const insertSkillTokenAtCaret = (el: HTMLElement, skill: SkillItem): void => {
  const sel = window.getSelection()
  let range: Range
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
    range.collapse(false)
  } else {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }
  const token = document.createElement('span')
  token.className = 'skill-token'
  token.dataset.skillId = String(skill.id)
  token.dataset.name = skill.name
  token.contentEditable = 'false'
  const icon = document.createElement('span')
  icon.className = 'skill-token-icon'
  icon.style.background = skill.color
  const flash = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  flash.setAttribute('width', '9')
  flash.setAttribute('height', '9')
  flash.setAttribute('viewBox', '0 0 24 24')
  flash.setAttribute('fill', 'none')
  flash.setAttribute('stroke', 'white')
  flash.setAttribute('stroke-width', '3')
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
  poly.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2')
  flash.appendChild(poly)
  const del = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  del.classList.add('skill-token-del')
  del.setAttribute('width', '10')
  del.setAttribute('height', '10')
  del.setAttribute('viewBox', '0 0 24 24')
  del.setAttribute('fill', 'none')
  del.setAttribute('stroke', 'white')
  del.setAttribute('stroke-width', '2.5')
  del.setAttribute('stroke-linecap', 'round')
  const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l1.setAttribute('x1', '18')
  l1.setAttribute('y1', '6')
  l1.setAttribute('x2', '6')
  l1.setAttribute('y2', '18')
  const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l2.setAttribute('x1', '6')
  l2.setAttribute('y1', '6')
  l2.setAttribute('x2', '18')
  l2.setAttribute('y2', '18')
  del.appendChild(l1)
  del.appendChild(l2)
  icon.appendChild(flash)
  icon.appendChild(del)
  const name = document.createElement('span')
  name.className = 'skill-token-name'
  name.textContent = skill.name
  token.appendChild(icon)
  token.appendChild(name)
  range.insertNode(token)
  range.setStartAfter(token)
  range.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(range)
  taskInput.value = el.innerText
}

/** 在光标处插入文件 token（图标 + 文件名；title 原生提示绝对路径），光标移到 token 后 */
const insertFileTokenAtCaret = (el: HTMLElement, filePath: string): void => {
  const sel = window.getSelection()
  let range: Range
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0)
    range.collapse(false)
  } else {
    range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
  }
  const token = document.createElement('span')
  token.className = 'file-token'
  token.dataset.path = filePath
  token.title = filePath // 悬停显示绝对路径（原生 tooltip）
  token.contentEditable = 'false'
  const icon = document.createElement('span')
  icon.className = 'file-token-icon'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '10')
  svg.setAttribute('height', '10')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'
  )
  svg.appendChild(path)
  const del = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  del.classList.add('file-token-del')
  del.setAttribute('width', '10')
  del.setAttribute('height', '10')
  del.setAttribute('viewBox', '0 0 24 24')
  del.setAttribute('fill', 'none')
  del.setAttribute('stroke', 'currentColor')
  del.setAttribute('stroke-width', '2.5')
  del.setAttribute('stroke-linecap', 'round')
  const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l1.setAttribute('x1', '18')
  l1.setAttribute('y1', '6')
  l1.setAttribute('x2', '6')
  l1.setAttribute('y2', '18')
  const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  l2.setAttribute('x1', '6')
  l2.setAttribute('y1', '6')
  l2.setAttribute('x2', '18')
  l2.setAttribute('y2', '18')
  del.appendChild(l1)
  del.appendChild(l2)
  icon.appendChild(svg)
  icon.appendChild(del)
  const name = document.createElement('span')
  name.className = 'file-token-name'
  name.textContent = filePath.split(/[\\/]/).pop() || filePath
  token.appendChild(icon)
  token.appendChild(name)
  range.insertNode(token)
  range.setStartAfter(token)
  range.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(range)
  taskInput.value = el.innerText
}

/** 从 DOM 移除第一个指定技能的 token */
const removeSkillTokenFromDom = (el: HTMLElement, id: string): void => {
  for (const node of Array.from(el.children)) {
    if (node instanceof HTMLElement && node.classList.contains('skill-token')) {
      if (node.dataset.skillId === id) {
        node.remove()
        break
      }
    }
  }
  taskInput.value = el.innerText
}

/** 菜单选技能：切 store 勾选（真相源）+ 同步 DOM（插入或移除 token） */
const onSelectSkillToken = (id: string): void => {
  const skill = catalog.skillItems.find((s) => s.id === id)
  const el = getInputEl()
  if (!skill || !el) return
  const willSelect = !catalog.selectedSkillIds.includes(id)
  catalog.toggleSkill(id)
  if (willSelect) insertSkillTokenAtCaret(el, skill)
  else removeSkillTokenFromDom(el, id)
}

// ── 文件附件：选中即时校验（主进程权威，此处为 UX 前置副本） ──
const FILE_TEXT_EXTS = [
  'txt',
  'md',
  'csv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'go',
  'rs',
  'sh',
  'sql',
  'log',
  'ini',
  'toml'
]
const FILE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
const FILE_MAX_TEXT_BYTES = 5 * 1024 * 1024
const FILE_MAX_PDF_BYTES = 20 * 1024 * 1024
const FILE_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const FILE_MAX_COUNT = 10

/** PlusMenu 选中本地文件 → 逐个即时校验（UX 前置），通过的在光标处插入文件 token */
const onSelectFiles = async (paths: string[]): Promise<void> => {
  const el = getInputEl()
  if (!el) return
  // 去重：同一文件多次选择只插一个 token
  const uniquePaths = [...new Set(paths)]
  if (uniquePaths.length > FILE_MAX_COUNT) {
    showToast('单次最多选择 ' + FILE_MAX_COUNT + ' 个文件')
    return
  }
  const accepted: string[] = []
  for (const p of uniquePaths) {
    const name = p.split(/[\\/]/).pop() ?? p
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const isText = FILE_TEXT_EXTS.includes(ext)
    const isImage = FILE_IMAGE_EXTS.includes(ext)
    const isPdf = ext === 'pdf'
    if (!isText && !isImage && !isPdf) {
      showToast('暂不支持该文件类型：' + name)
      continue
    }
    const res = await window.api.inspectFile(p)
    if (!res.success) {
      showToast(res.error ?? '文件校验失败')
      continue
    }
    const data = res.data
    if (!data || !data.exists) {
      showToast('文件不存在：' + name)
      continue
    }
    if (data.kind === 'unsupported') {
      // 主进程权威分类兜底（防两份扩展名列表漂移）
      showToast('暂不支持该文件类型：' + name)
      continue
    }
    const limit =
      data.kind === 'text'
        ? FILE_MAX_TEXT_BYTES
        : data.kind === 'image'
          ? FILE_MAX_IMAGE_BYTES
          : FILE_MAX_PDF_BYTES
    if (data.size > limit) {
      showToast('文件过大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）：' + name)
      continue
    }
    accepted.push(p)
  }
  // await 期间输入框可能已卸载（弹窗关闭），守卫防插入到游离 DOM
  if (!el.isConnected) return
  for (const p of accepted) insertFileTokenAtCaret(el, p)
}

// ── 拖拽文件入输入框（效果与「+ → 添加文件 → 本地文件」一致） ──
const inputDragging = ref(false)
let fileDragDepth = 0

/** 仅响应文件拖拽（文本拖拽保留浏览器默认插入） */
const isFileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

/** 拖入输入框：高亮提示可放置（dragenter/dragleave 在子节点间冒泡，用深度计数防闪烁） */
const onInputDragEnter = (e: DragEvent): void => {
  e.preventDefault()
  if (!isFileDrag(e)) return
  fileDragDepth++
  inputDragging.value = true
}

/** 持续派发时阻止默认（否则 drop 不被允许） */
const onInputDragOver = (e: DragEvent): void => {
  e.preventDefault()
}

const onInputDragLeave = (e: DragEvent): void => {
  if (!isFileDrag(e)) return
  fileDragDepth = Math.max(0, fileDragDepth - 1)
  if (fileDragDepth === 0) inputDragging.value = false
}

/** 松手：光标定位到拖放点，解析真实路径后复用 onSelectFiles 的校验与插入管线 */
const onInputDrop = (e: DragEvent): void => {
  fileDragDepth = 0
  inputDragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return // 文本拖拽：不做拦截，保留浏览器默认插入
  e.preventDefault()
  const el = getInputEl()
  if (!el) return
  // 光标定位到拖放点（caretRangeFromPoint 为 Chromium 扩展 API，Electron 可用）
  const range = document.caretRangeFromPoint(e.clientX, e.clientY)
  if (range) {
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  // Electron 39 起 File.path 已移除：经 preload 的 webUtils.getPathForFile 解析真实路径
  const paths = files.map((f) => window.api.getPathForFile(f)).filter((p): p is string => !!p)
  if (!paths.length) {
    showToast('无法读取文件，请从本地文件夹重新拖入')
    return
  }
  void onSelectFiles(paths)
}

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

/** 移除专家选择（提示词由 watcher 从输入框移除） */
const removeExpert = (): void => {
  catalog.clearExpert()
}

/** 从输入框文本中剔除提示词原文（前缀优先，兜底扫描任意文本节点） */
const removePromptFromDom = (el: HTMLElement, prompt: string): void => {
  const prefix = prompt + '\n'
  const first = el.firstChild
  if (first && first.nodeType === Node.TEXT_NODE && (first.textContent ?? '').startsWith(prefix)) {
    const rest = (first.textContent ?? '').slice(prefix.length)
    if (rest) first.textContent = rest
    else el.removeChild(first)
    return
  }
  // 兜底：提示词被编辑或移位时，在任何文本节点中剔除原文
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').includes(prompt)) {
      node.textContent = (node.textContent ?? '').split(prompt).join('').replace(/^\n+/, '')
      return
    }
  }
}

/** 专家提示词与 contenteditable DOM 同步（插入开头；切换专家先剔除旧提示词再插入新提示词） */
const syncExpertPromptToDom = (el: HTMLElement, prompt: string, prev: string): void => {
  if (prompt && prev && prompt !== prev && el.innerText.includes(prev)) {
    // 切换专家：先剔除上一个专家的提示词，避免叠加成两条
    removePromptFromDom(el, prev)
  }
  if (prompt && !el.innerText.includes(prompt)) {
    el.insertBefore(document.createTextNode(prompt + '\n'), el.firstChild)
  } else if (!prompt && prev) {
    removePromptFromDom(el, prev)
  }
  taskInput.value = el.innerText
}

const pendingExpertPromptSync = ref(false)

watch(
  () => catalog.selectedExpertPrompt,
  (prompt, prev) => {
    const el = getInputEl()
    if (el) syncExpertPromptToDom(el, prompt, prev ?? '')
    else pendingExpertPromptSync.value = true
  },
  { immediate: true }
)

/** 输入框挂载时补做待处理的专家提示词同步 */
watch(inputRef, (el) => {
  if (el && pendingExpertPromptSync.value) {
    pendingExpertPromptSync.value = false
    syncExpertPromptToDom(el, catalog.selectedExpertPrompt, '')
  }
})

/** 菜单内导航（专家 / 技能 / 连接器页面）由父级决定是否响应 */
const onPlusNavigate = (tab: CatalogTab): void => {
  showInputPlusMenu.value = false
  emit('navigate', tab)
}

// ── 模型选择 ──
/** 内置模型（仅 Auto 走默认 agent 配置；其余模型经 modelStore 追加展示） */
const BUILTIN_MODELS = ['Auto']

/** 当前选中的自定义模型 id（内置模型为 null） */
const selectedCustomId = ref<string | null>(null)

/** 模型下拉分组：内置 + 自定义（自定义模型名可重复，id 唯一，故按 id 传参） */
const modelGroups = computed(() => [
  {
    name: '内置模型',
    items: BUILTIN_MODELS.map((name) => ({ name, id: undefined as string | undefined }))
  },
  { name: '自定义模型', items: modelStore.models.map((m) => ({ name: m.name, id: m.id })) }
])

const selectModel = (opt: { name: string; id?: string }): void => {
  model.value = opt.name
  selectedCustomId.value = opt.id ?? null
  modelOpen.value = false
}

// ── hover 菜单控制器：按钮移入打开，移出延迟关闭（给鼠标移入菜单留时间） ──
interface HoverMenu {
  open: () => void
  scheduleClose: () => void
  cancelClose: () => void
  closeNow: () => void
}

const createHoverMenu = (flag: Ref<boolean>): HoverMenu => {
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  const open = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    flag.value = true
  }
  const scheduleClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      flag.value = false
    }, 200)
  }
  const cancelClose = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
  }
  const closeNow = (): void => {
    if (closeTimer) clearTimeout(closeTimer)
    flag.value = false
  }
  return { open, scheduleClose, cancelClose, closeNow }
}

const modelMenuHover = createHoverMenu(modelOpen)
const plusMenuHover = createHoverMenu(showInputPlusMenu)

// ── Workspace selector 状态 ──
const wsMenuOpen = ref(false)
const showCreateModal = ref(false)
const createName = ref('')
const createError = ref('')
const creating = ref(false)

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

/** 打开「新建工作空间」弹窗 */
const openCreateModal = (): void => {
  wsMenuOpen.value = false
  createName.value = ''
  createError.value = ''
  showCreateModal.value = true
}

/** 确认创建：主进程 sanitize 是权威校验，错误经 createError 展示 */
const confirmCreate = async (): Promise<void> => {
  const name = createName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    await workspaceStore.create(name)
    showCreateModal.value = false
    createName.value = ''
  } catch (err) {
    createError.value = err instanceof Error ? err.message : '新建工作空间失败'
  } finally {
    creating.value = false
  }
}

// ── 权限菜单：默认权限 / 允许完全访问（渲染层本地状态，localStorage 持久化） ──
const FULL_ACCESS_KEY = 'ke-work.full-access'
const fullAccess = ref(localStorage.getItem(FULL_ACCESS_KEY) === '1')
const permMenuOpen = ref(false)
const showPermConfirm = ref(false)
const riskChecked = ref(false)

watch(fullAccess, (v) => {
  localStorage.setItem(FULL_ACCESS_KEY, v ? '1' : '0')
})

/** 点击开关：关闭到开启需经风险确认弹窗；开启到关闭直接切换 */
const onPermSwitchClick = (): void => {
  if (fullAccess.value) {
    fullAccess.value = false
  } else {
    riskChecked.value = false
    showPermConfirm.value = true
  }
}

const confirmFullAccess = (): void => {
  fullAccess.value = true
  showPermConfirm.value = false
}

const cancelFullAccess = (): void => {
  showPermConfirm.value = false
}

// ── 轻量 toast（文件校验 / 改写失败的即时提示） ──
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
const showToast = (text: string): void => {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 1800)
}

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
  modelOpen.value = false
  showInputPlusMenu.value = false
  emit('submit', payload)
}

/** 清空输入框（正文 + 技能 / 文件 token + 技能勾选 + 专家提示词） */
const clear = (): void => {
  const el = getInputEl()
  if (el) el.textContent = ''
  taskInput.value = ''
  catalog.clearSkills()
  const holder = el ?? document.createElement('div')
  if (catalog.selectedExpertPrompt) removePromptFromDom(holder, catalog.selectedExpertPrompt)
  catalog.clearExpert()
}

/** 聚焦输入框（弹窗打开后可直接输入） */
const focus = (): void => {
  inputRef.value?.focus()
}

defineExpose({ clear, focus, buildPayload })

// ── 点击外部关闭菜单 ──
const handleDocumentClick = (e: MouseEvent): void => {
  const target = e.target as HTMLElement
  if (!target.closest('[data-prompt-plus-trigger]') && !target.closest('.plus-menu')) {
    showInputPlusMenu.value = false
  }
  if (!target.closest('[data-prompt-ws-trigger]') && !target.closest('.workspace-menu')) {
    wsMenuOpen.value = false
  }
  if (!target.closest('[data-prompt-perm-trigger]') && !target.closest('.perm-menu')) {
    permMenuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
  // 自定义模型列表（设置页新增后下拉同步刷新；失败静默保留旧值）
  void modelStore.load()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDocumentClick)
  if (toastTimer) clearTimeout(toastTimer)
  // 弹窗关闭时丢弃未提交草稿的技能勾选，避免污染下次打开
  if (taskInput.value.trim()) catalog.clearSkills()
  catalog.clearExpert()
})
</script>

<template>
  <div class="prompt-input">
    <!-- 输入卡 -->
    <div class="input-card">
      <div
        ref="inputRef"
        class="task-textarea"
        :class="{ 'task-textarea--dragging': inputDragging }"
        contenteditable="true"
        :data-placeholder="placeholder"
        @input="onInputSync"
        @click="onInputClick"
        @keydown.enter.exact.prevent="onSend"
        @dragenter="onInputDragEnter"
        @dragover="onInputDragOver"
        @dragleave="onInputDragLeave"
        @drop="onInputDrop"
      ></div>
      <div v-if="selectionChips.length" class="selection-chips">
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
      <div class="input-toolbar">
        <button
          class="toolbar-btn"
          data-prompt-plus-trigger
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
        <!-- 模型选择 -->
        <div class="model-selector">
          <button
            class="model-btn"
            @mouseenter="modelMenuHover.open"
            @mouseleave="modelMenuHover.scheduleClose"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {{ model }}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Transition name="dropdown">
            <div
              v-if="modelOpen"
              class="model-dropdown"
              @mouseenter="modelMenuHover.cancelClose"
              @mouseleave="modelMenuHover.closeNow"
            >
              <template v-for="group in modelGroups" :key="group.name">
                <div v-if="group.items.length > 0" class="model-group-label">
                  {{ group.name }}
                </div>
                <button
                  v-for="opt in group.items"
                  :key="opt.id ?? opt.name"
                  :class="['model-option', { 'model-option--active': model === opt.name }]"
                  @click="selectModel(opt)"
                >
                  <svg
                    v-if="model === opt.name"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span v-else class="model-option-gap"></span>
                  {{ opt.name }}
                </button>
              </template>
            </div>
          </Transition>
        </div>
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
          <button class="footer-action" data-prompt-ws-trigger @click="wsMenuOpen = !wsMenuOpen">
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
        <div class="perm-selector">
          <button
            class="footer-action"
            data-prompt-perm-trigger
            @click="permMenuOpen = !permMenuOpen"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            默认权限
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
            <div v-if="permMenuOpen" class="perm-menu" @click.stop>
              <p class="perm-desc">
                当前为默认权限，所有操作都会在安全沙箱约束内进行，超出范围会请求你的允许。
              </p>
              <div class="perm-row">
                <span class="perm-row-label">允许完全访问</span>
                <button
                  class="perm-switch"
                  :class="{ 'perm-switch--on': fullAccess }"
                  type="button"
                  role="switch"
                  :aria-checked="fullAccess"
                  title="开启后将减少确认步骤，允许 AI 直接执行更多操作。可能涉及敏感操作、文件修改或外部执行"
                  @click="onPermSwitchClick"
                >
                  <span class="perm-switch-knob"></span>
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
    <!-- 允许完全访问风险确认 Modal -->
    <Transition name="modal">
      <div v-if="showPermConfirm" class="perm-mask" @click.self="cancelFullAccess">
        <div class="perm-confirm-card">
          <div class="perm-confirm-header">
            <span>开启允许完全访问</span>
            <button
              class="perm-confirm-close"
              type="button"
              aria-label="关闭"
              @click="cancelFullAccess"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="perm-confirm-body">
            <p class="perm-confirm-message">
              开启允许完全访问后，AI
              将减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部执行。仅建议在您信任当前任务时使用。
            </p>
            <label class="perm-risk">
              <input v-model="riskChecked" type="checkbox" class="perm-risk-checkbox" />
              <span>我已了解风险，并愿意继续</span>
            </label>
          </div>
          <div class="perm-confirm-footer">
            <button
              class="perm-confirm-btn perm-confirm-btn--cancel"
              type="button"
              @click="cancelFullAccess"
            >
              取消
            </button>
            <button
              class="perm-confirm-btn perm-confirm-btn--confirm"
              type="button"
              :disabled="!riskChecked"
              @click="confirmFullAccess"
            >
              允许完全访问
            </button>
          </div>
        </div>
      </div>
    </Transition>
    <!-- 新建工作空间 Modal -->
    <Transition name="modal">
      <div v-if="showCreateModal" class="ws-modal-mask" @click.self="showCreateModal = false">
        <div class="ws-modal-card">
          <div class="ws-modal-header">
            <span>新建工作空间</span>
            <button class="ws-modal-close" aria-label="关闭" @click="showCreateModal = false">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="ws-modal-body">
            <label class="ws-modal-label" for="prompt-ws-create-name">工作空间名称</label>
            <input
              id="prompt-ws-create-name"
              v-model="createName"
              class="ws-modal-input"
              maxlength="50"
              placeholder="将创建于 ~/KeWork/ 目录下"
              @keydown.enter.prevent="confirmCreate"
            />
            <p v-if="createError" class="ws-modal-error">{{ createError }}</p>
            <p class="ws-modal-hint">将在系统家目录的 KeWork/ 下创建同名文件夹</p>
          </div>
          <div class="ws-modal-footer">
            <button class="ws-modal-btn ws-modal-btn--cancel" @click="showCreateModal = false">
              取消
            </button>
            <button
              class="ws-modal-btn ws-modal-btn--confirm"
              :disabled="creating || !createName.trim()"
              @click="confirmCreate"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 轻量提示 -->
    <Transition name="dropdown">
      <div v-if="toast" class="input-toast">{{ toast }}</div>
    </Transition>
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

.input-card {
  position: relative;
  width: 100%;
  border-radius: 16px;
  border: 1.5px solid var(--kw-color-border-brand);
  box-shadow: 0 4px 24px rgba(8, 145, 178, 0.08);
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
  max-height: 220px;
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
.model-selector {
  position: relative;
}

.model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.model-btn:hover {
  background: var(--kw-color-brand-soft);
}

.model-btn svg:first-child {
  color: var(--kw-color-brand);
}

.model-dropdown {
  position: absolute;
  /* 弹窗内空间有限：向下展开，避免菜单顶部被窗口裁切 */
  top: calc(100% + 4px);
  bottom: auto;
  right: 0;
  min-width: 160px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  z-index: 20;
}

.model-group-label {
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 600;
  color: var(--kw-color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 12px;
  font-family: inherit;
  color: var(--kw-color-text-secondary);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.1s ease;
}

.model-option:hover {
  background: var(--kw-color-brand-hover);
}

.model-option--active {
  color: var(--kw-color-brand);
  font-weight: 600;
}

.model-option-gap {
  width: 10px;
}

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

/* 输入卡底部 */
.input-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 10px;
  border-top: 1px solid var(--kw-color-border-brand);
}

.footer-action {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--kw-color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.footer-action:hover {
  background: var(--kw-color-brand-hover);
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

/* 权限菜单（默认权限 / 允许完全访问） */
.perm-selector {
  position: relative;
}

.perm-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 300px;
  padding: 12px 14px;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border);
  border-radius: 10px;
  box-shadow:
    0 -2px 16px rgba(0, 0, 0, 0.1),
    0 4px 20px rgba(0, 0, 0, 0.08);
  z-index: 100;
}

.perm-desc {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--kw-color-text-muted);
}

.perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.perm-row-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text);
}

/* 开关（与 PlusMenu 模式开关同视觉） */
.perm-switch {
  position: relative;
  width: 30px;
  height: 17px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: #e2e8f0;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.perm-switch--on {
  background: var(--kw-gradient-brand);
}

.perm-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--kw-color-surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.15s ease;
}

.perm-switch--on .perm-switch-knob {
  transform: translateX(13px);
}

/* 风险确认弹窗 */
.perm-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.perm-confirm-card {
  width: 420px;
  background: var(--kw-color-surface);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
  overflow: hidden;
}

.perm-confirm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.perm-confirm-close {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.perm-confirm-close:hover {
  background: var(--kw-color-bg-muted);
}

.perm-confirm-body {
  padding: 0 20px 12px;
}

.perm-confirm-message {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--kw-color-text-secondary);
}

.perm-risk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--kw-color-bg-soft);
  border: 1px solid var(--kw-color-border);
  cursor: pointer;
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.perm-risk-checkbox {
  accent-color: var(--kw-color-brand);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.perm-confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
}

.perm-confirm-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease;
}

.perm-confirm-btn--cancel {
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
}

.perm-confirm-btn--cancel:hover {
  background: #e5e7eb;
}

.perm-confirm-btn--confirm {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
}

.perm-confirm-btn--confirm:hover {
  opacity: 0.9;
}

.perm-confirm-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 新建工作空间弹窗 */
.ws-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.ws-modal-card {
  width: 360px;
  background: var(--kw-color-surface);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.2);
  overflow: hidden;
}

.ws-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.ws-modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.ws-modal-close:hover {
  background: var(--kw-color-bg-muted);
}

.ws-modal-body {
  padding: 0 20px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-modal-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.ws-modal-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid #d1d9e6;
  border-radius: 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.ws-modal-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px rgba(8, 145, 178, 0.12);
}

.ws-modal-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--kw-color-danger);
}

.ws-modal-hint {
  margin: 0;
  font-size: 11px;
  color: var(--kw-color-text-subtle);
}

.ws-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 20px 16px;
}

.ws-modal-btn {
  padding: 8px 18px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease;
}

.ws-modal-btn--cancel {
  background: var(--kw-color-bg-muted);
  color: var(--kw-color-text-secondary);
}

.ws-modal-btn--cancel:hover {
  background: #e5e7eb;
}

.ws-modal-btn--confirm {
  background: var(--kw-gradient-brand);
  color: var(--kw-color-on-accent);
}

.ws-modal-btn--confirm:hover {
  opacity: 0.9;
}

.ws-modal-btn--confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 轻量提示 */
.input-toast {
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

/* 过渡动画 */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.plus-menu-slide-enter-active {
  transition: all 0.2s ease-out;
}

.plus-menu-slide-leave-active {
  transition: all 0.15s ease-in;
}

.plus-menu-slide-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}

.plus-menu-slide-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.97);
}
</style>
