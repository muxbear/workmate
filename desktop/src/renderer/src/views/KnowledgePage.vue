<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import KnowledgeDetailModal from '../components/knowledge/KnowledgeDetailModal.vue'
import KnowledgeEditModal from '../components/knowledge/KnowledgeEditModal.vue'
import KnowledgeRenameModal from '../components/knowledge/KnowledgeRenameModal.vue'
import KnowledgeSettingsModal from '../components/knowledge/KnowledgeSettingsModal.vue'
import KnowledgeShareModal from '../components/knowledge/KnowledgeShareModal.vue'
import KnowledgeUploadModal from '../components/knowledge/KnowledgeUploadModal.vue'
import {
  type KnowledgeFolder,
  type KnowledgeGroup
} from '../components/knowledge/knowledgeList'
import {
  collectFileNodes,
  findNode,
  flattenVisible,
  mergeUploads,
  parentKeyOf,
  remapKey,
  sortTree,
  type KnowledgeFileIcon,
  type KnowledgeFileMeta,
  type KnowledgeNode,
  type KnowledgeSortKey
} from '../components/knowledge/knowledgeTree'
import type { KnowledgeUploadPayload } from '../components/knowledge/uploadIndex'
import KnowledgeCreateModal from '../components/knowledge/KnowledgeCreateModal.vue'
import FilePreviewPane from '../components/file-preview/FilePreviewPane.vue'
import { createKnowledgeFileSource } from '../components/file-preview/sources'
import KnowledgeOverviewModal from '../components/knowledge/KnowledgeOverviewModal.vue'
import { useKnowledgeSettingsStore } from '../store/knowledgeSettings'
import { useKnowledgeStore } from '../store/knowledge'
import type {
  KnowledgeBaseSummary,
  KnowledgeDocumentMeta,
  KnowledgeKind
} from '../../../preload/index.d'

// ── 知识库数据模型（知识库列表见 components/knowledge/knowledgeList.ts，文件树见 knowledgeTree.ts） ──
type FileIcon = KnowledgeFileIcon
/** 文件元信息（列表行与右侧预览标签页共用） */
type KnowledgeTreeNode = KnowledgeNode
type SortKey = KnowledgeSortKey
/** 创建共享的对象类型 */
type ShareKind = 'library' | 'folder' | 'file'

// ── 知识库分组（本地 / 共享 / 云端）──
/** 三个固定分组：条目来自主进程（knowledge:list-kbs），分组只决定展示位置 */
const KNOWLEDGE_GROUPS: Array<Pick<KnowledgeGroup, 'id' | 'label' | 'icon'>> = [
  { id: 'local', label: '本地知识库', icon: 'hard-drive' },
  { id: 'shared', label: '我的共享知识', icon: 'users' },
  { id: 'cloud', label: '云端知识库', icon: 'cloud' }
]

/** 知识库徽标配色：按 id 稳定取色，避免列表刷新时颜色跳动 */
const LIBRARY_TONES = ['#168b7a', '#3b82f6', '#d97706', '#8b5cf6', '#0f9f8a', '#e8793d']
function toneOf(id: string): string {
  let sum = 0
  for (const ch of id) sum += ch.charCodeAt(0)
  return LIBRARY_TONES[sum % LIBRARY_TONES.length]
}

/** 文件图标底色（与上传弹窗同一套色板） */
const FILE_TINTS: Record<string, string> = {
  pdf: '#ef4444',
  doc: '#3b82f6',
  docx: '#3b82f6',
  xls: '#16a34a',
  xlsx: '#16a34a',
  csv: '#16a34a',
  ppt: '#e8793d',
  pptx: '#e8793d',
  md: '#168b7a',
  txt: '#168b7a'
}

// ── 侧栏分组与选中知识库（数据来自 store；渲染层只持 ID 与相对路径）──
const kbStore = useKnowledgeStore()
const expanded = ref<Record<string, boolean>>({ local: true, shared: true, cloud: true })
const moreGroupId = ref<string | null>(null)
const openGroupMenu = ref<string | null>(null)
/** 新建知识库弹窗：目标分组 */
const createOpen = ref(false)
const createKind = ref<KnowledgeKind>('local')
/** 概览弹窗 */
const overviewOpen = ref(false)

/** 空态占位：没有知识库时详情区仍可渲染（只做属性读取） */
const EMPTY_LIBRARY: KnowledgeFolder = {
  id: '',
  name: '知识库',
  description: '还没有知识库，可从分组菜单新建',
  files: 0,
  updated: '—',
  tone: '#168b7a'
}

/** 主进程知识库 → 侧栏条目 */
function toFolder(base: KnowledgeBaseSummary): KnowledgeFolder {
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    files: base.docsCount,
    updated: formatTimestamp(base.updatedAt),
    tone: toneOf(base.id)
  }
}

/** 按 kind 聚合的三个分组（空分组保留，便于「新建知识库」入口） */
const knowledgeGroups = computed<KnowledgeGroup[]>(() =>
  KNOWLEDGE_GROUPS.map((group) => ({
    ...group,
    items: kbStore.bases.filter((base) => base.kind === group.id).map(toFolder)
  }))
)

/** 当前选中的知识库（详情区与所有动作都基于它） */
const selectedLibrary = computed<KnowledgeFolder>(() => {
  const base = kbStore.selectedBase
  return base ? toFolder(base) : EMPTY_LIBRARY
})

// ── 知识库条目三点菜单与三个弹窗 ──
/** 当前展开三点菜单的知识库 id（同一时刻只允许一个） */
const openLibMenu = ref<string | null>(null)
/** 知识库设置弹窗目标（按库覆盖配置） */
const settingsLibrary = ref<KnowledgeFolder | null>(null)
const settingsOpen = ref(false)
/** 知识库编辑弹窗目标 */
const editLibrary = ref<KnowledgeFolder | null>(null)
const editOpen = ref(false)
/** 待确认删除的知识库 */
const deleteCandidate = ref<KnowledgeFolder | null>(null)
/** 按库覆盖配置（弹窗内保存/删除时清理） */
const knowledgeSettingsStore = useKnowledgeSettingsStore()

// ── 文件列表：文件树、排序、上传、标签页 ──
/** 文件树：由主进程文档元信息（relPath）还原层级，key 即相对路径 */
const fileTree = ref<KnowledgeTreeNode[]>([])

/** 当前选中知识库 ID（无知识库时为空串） */
const selectedKbId = computed(() => kbStore.selectedBase?.id ?? '')

/** 主进程文档元信息 → 列表条目（图标/配色与上传结果保持同一套规则） */
function metaOf(doc: KnowledgeDocumentMeta): KnowledgeFileMeta {
  const ext = doc.name.split('.').pop()?.toLowerCase() ?? ''
  return {
    name: doc.name,
    type: doc.type,
    size: formatSize(doc.sizeBytes),
    sizeBytes: doc.sizeBytes,
    updated: formatTimestamp(doc.updatedAt),
    icon: pickFileIcon(ext),
    tint: FILE_TINTS[ext] ?? '#64748b',
    indexState: doc.indexState
  }
}

/** 用文档列表重建文件树（复用 mergeUploads：文件夹是逻辑结构，来自 relPath） */
function rebuildFileTree(docs: KnowledgeDocumentMeta[]): void {
  const entries = docs.map((doc) => ({
    dirs: doc.relPath.split('/').slice(0, -1),
    file: metaOf(doc)
  }))
  fileTree.value = mergeUploads([], entries)
  // 目录结构由 relPath 还原（与上传的文件夹层级一致）；
  // 这里**不**自动展开：文件夹默认折叠，由用户点击展开
}

// 文档列表变化（切换知识库 / 上传 / 删除 / 重命名后）重建树
watch(
  () => kbStore.documentsOf(selectedKbId.value),
  (docs) => rebuildFileTree(docs),
  { immediate: true, deep: true }
)
/** 文件夹展开状态（缺省折叠：只有显式展开过的目录才展开） */
const folderExpanded = ref<Record<string, boolean>>({})

/** 文件夹是否展开（缺省折叠；rows 与模板的折叠箭头共用同一判定） */
function isFolderExpanded(key: string): boolean {
  return folderExpanded.value[key] === true
}
const sortKey = ref<SortKey>('updated')
const ascending = ref(false)
/** 标签页以文件 key 标识（'问答' 是常驻标签） */
const openTabs = ref<string[]>(['问答'])
const activeTab = ref('问答')
/** 问答区域是否收起（默认收起：整个问答区域不显示） */
const panelCollapsed = ref(true)
/** 问答区域是否全屏 */
const panelFullscreen = ref(false)
/** 文件行三点菜单当前展开的 key */
const fileMenuKey = ref<string | null>(null)
/** 知识库名字右侧的操作菜单是否展开 */
const libraryMenuOpen = ref(false)

// ── 问答 ──
const question = ref('')
const answer = ref('')

// ── 左右分栏拖拽 ──
const filePanelPercent = ref(40)
const detailRef = ref<HTMLElement | null>(null)

/** 左侧知识库分组栏宽度：可拖动分割栏调整，并记住到本地 */
const GROUPS_WIDTH_KEY = 'ke-work.kb-groups-width'
const GROUPS_WIDTH_DEFAULT = 250
const GROUPS_WIDTH_MIN = 180
const GROUPS_WIDTH_MAX = 420

/** 读取本地记住的侧栏宽度（非法/越界值回退默认） */
function readGroupsWidth(): number {
  const saved = Number(localStorage.getItem(GROUPS_WIDTH_KEY))
  if (!Number.isFinite(saved) || saved <= 0) return GROUPS_WIDTH_DEFAULT
  return Math.min(GROUPS_WIDTH_MAX, Math.max(GROUPS_WIDTH_MIN, saved))
}

const groupsWidth = ref(readGroupsWidth())

// ── 文件上传 ──
/** 上传弹窗：选文件 → 选择上传后处理方式 → 需要时进入索引配置向导 */
const uploadOpen = ref(false)
/** 上传文件夹仍走系统目录选择 */
const folderUploadRef = ref<HTMLInputElement | null>(null)

// ── 标签栏横向滚动 ──
const tabBarRef = ref<HTMLElement | null>(null)
const tabScroll = ref({ left: false, right: false })

const moreGroup = computed(
  () => knowledgeGroups.value.find((group) => group.id === moreGroupId.value) ?? null
)

/** 排序后的文件树（文件夹恒排在文件前） */
const sortedTree = computed(() => sortTree(fileTree.value, sortKey.value, ascending.value))

/** 展开可见行：文件夹折叠时跳过其子节点 */
const rows = computed(() => flattenVisible(sortedTree.value, isFolderExpanded))

/** 全部文件节点（不含文件夹） */
const allFiles = computed(() => collectFileNodes(fileTree.value))

/** 当前标签对应的节点（'问答' 不是节点，返回 null） */
const activeNode = computed(() => findNode(fileTree.value, activeTab.value))

/** 标签页显示名：文件重命名后跟着更新 */
const tabLabel = (tab: string): string => findNode(fileTree.value, tab)?.name ?? tab

/** 已建立索引的文件数（「只上传文件」的条目不计数） */
const indexedCount = computed(
  () => allFiles.value.filter((node) => node.file?.indexState !== 'none').length
)

/** 文件区副标题：文件总数与索引情况（索引未开放时不做「0 份已建立索引」的误导表述） */
const fileSummary = computed(() => {
  const total = allFiles.value.length
  if (!total) return '暂无文件'
  if (indexedCount.value === 0) return `${total} 份文件 · 索引功能开发中`
  if (indexedCount.value === total) return `${total} 份文件已建立索引`
  return `${total} 份文件 · ${indexedCount.value} 份已建立索引`
})

/** 列表里的索引标记：只上传的文件与自定义索引的文件需要单独标出 */
const indexTagText = (node: KnowledgeTreeNode): string => {
  if (node.file?.indexState === 'none') return '未索引'
  if (node.file?.indexState === 'custom') return '自定义索引'
  return ''
}

/** 索引状态文案（详情弹窗用，undefined 视为已建立索引） */
const indexStateText = (node: KnowledgeTreeNode): string => {
  if (node.file?.indexState === 'none') return '未建立索引'
  if (node.file?.indexState === 'custom') return '自定义索引'
  return '已建立索引'
}

/** 「查看更多」页：当前分组下的知识库 + 两个归档卡片 */
/** 「查看更多」页：当前分组下的全部知识库（真实数据，不再有占位卡片） */
const moreLibraries = computed<KnowledgeFolder[]>(() => moreGroup.value?.items ?? [])

// ── 轻量 toast（与页面级 toast 同视觉） ──
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
const notify = (text: string): void => {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 1800)
}
onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})

// ── 分组操作 ──
const toggleGroup = (groupId: string): void => {
  expanded.value = { ...expanded.value, [groupId]: !expanded.value[groupId] }
}

/** 新建知识库：打开弹窗（分组决定 kind），提交后由主进程落库 */
const addKnowledgeLibrary = (groupId: string): void => {
  createKind.value = groupId === 'shared' || groupId === 'cloud' ? groupId : 'local'
  createOpen.value = true
  openGroupMenu.value = null
}

/** 新建弹窗提交 */
const onCreateLibrary = async (payload: {
  name: string
  description: string
}): Promise<void> => {
  const created = await kbStore.createBase({
    name: payload.name,
    description: payload.description,
    kind: createKind.value
  })
  if (!created) {
    notify(kbStore.lastError || '创建知识库失败')
    return
  }
  toggleGroupOpen(created.kind, true)
  notify(`已创建「${created.name}」`)
}

const toggleGroupOpen = (groupId: string, open: boolean): void => {
  expanded.value = { ...expanded.value, [groupId]: open }
}

const selectLibrary = (library: KnowledgeFolder): void => {
  if (!library.id) return
  void kbStore.selectBase(library.id)
  activeTab.value = '问答'
}

const selectFromMore = (library: KnowledgeFolder): void => {
  selectLibrary(library)
  moreGroupId.value = null
}

const openMoreGroup = (groupId: string): void => {
  openGroupMenu.value = null
  moreGroupId.value = groupId
}

/**
 * 点击分组三点按钮：只负责「打开」菜单。
 *
 * 菜单本身由 `@mouseenter` 展开，若这里再做 toggle，鼠标点击会立刻把刚展开的菜单关掉
 * （hover 与 click 互相抵消）；关闭交给移出分组、点击空白处或 Esc。
 */
const toggleGroupMenu = (groupId: string): void => {
  openGroupMenu.value = groupId
  openLibMenu.value = null
}

// ── 知识库条目操作（三点菜单：编辑 / 设置 / 删除）──
/** 同一时刻只展开一个菜单：分组菜单与条目菜单互斥 */
const toggleLibMenu = (libraryId: string): void => {
  openLibMenu.value = openLibMenu.value === libraryId ? null : libraryId
  openGroupMenu.value = null
}

const openEditLibrary = (library: KnowledgeFolder): void => {
  openLibMenu.value = null
  editLibrary.value = library
  editOpen.value = true
}

/** 编辑保存（名称 + 描述）：写主进程，成功后按返回值刷新列表 */
const saveLibraryEdit = async (name: string, description: string): Promise<void> => {
  const target = editLibrary.value
  editLibrary.value = null
  if (!target) return
  const ok = await kbStore.updateBase(target.id, { name, description })
  notify(ok ? `已更新「${name}」` : kbStore.lastError || '保存失败')
}

const openLibrarySettings = (library: KnowledgeFolder): void => {
  openLibMenu.value = null
  settingsLibrary.value = library
  settingsOpen.value = true
}

const askDeleteLibrary = (library: KnowledgeFolder): void => {
  openLibMenu.value = null
  deleteCandidate.value = library
}

/** 删除确认：主进程级联清理文档与磁盘，再清渲染层的按库配置缓存 */
const confirmDeleteLibrary = async (): Promise<void> => {
  const target = deleteCandidate.value
  deleteCandidate.value = null
  if (!target) return
  const ok = await kbStore.removeBase(target.id)
  if (!ok) {
    notify(kbStore.lastError || '删除失败')
    return
  }
  // 主进程已清 kb-settings.json；渲染层同步清缓存，避免弹窗仍显示旧覆盖
  await knowledgeSettingsStore.saveOverrides(target.id, {})
  openTabs.value = ['问答']
  activeTab.value = '问答'
  notify(`已删除「${target.name}」`)
}

const onLibrarySettingsSaved = (name: string): void => {
  notify(`「${name}」设置已保存`)
}

/** 点击菜单以外的区域关闭菜单（侧栏条目菜单 / 文件行菜单 / 知识库操作菜单） */
const onDocumentMousedown = (event: MouseEvent): void => {
  const element = event.target instanceof Element ? event.target : null
  if (openLibMenu.value && !element?.closest('.kb-lib-row')) openLibMenu.value = null
  if (fileMenuKey.value && !element?.closest('.kb-row-more')) fileMenuKey.value = null
  if (libraryMenuOpen.value && !element?.closest('.kb-library-menu-wrap')) {
    libraryMenuOpen.value = false
  }
}

const onDocumentKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return
  openLibMenu.value = null
  fileMenuKey.value = null
  libraryMenuOpen.value = false
  // 问答区域全屏时按 Esc = 退出全屏，回到展开的分栏宽度
  if (panelFullscreen.value) {
    panelFullscreen.value = false
    panelCollapsed.value = false
  }
}

// ── 文件夹展开 / 文件标签页 ──
const toggleFolder = (key: string): void => {
  folderExpanded.value = { ...folderExpanded.value, [key]: !isFolderExpanded(key) }
}

/** 选中文件：在最右侧以标签页打开（已打开则直接切过去） */
const openFile = (node: KnowledgeTreeNode): void => {
  if (node.kind !== 'file') return
  // 选中文件时确保问答区域显示出来，否则标签页会藏在收起的面板里
  panelCollapsed.value = false
  if (!openTabs.value.includes(node.key)) openTabs.value = [...openTabs.value, node.key]
  activeTab.value = node.key
  libraryMenuOpen.value = false
}

// ── 文件预览（复用共享组件 FilePreviewPane；知识库侧为自加载模式）──
/** 当前文件标签对应的预览来源（null = 未选中文件） */
const previewSource = computed(() => {
  const node = activeNode.value
  const kbId = selectedKbId.value
  if (!node || node.kind !== 'file' || !kbId) return null
  return createKnowledgeFileSource(kbId, { name: node.name, relPath: node.key })
})

const closeTab = (tab: string): void => {
  openTabs.value = openTabs.value.filter((item) => item !== tab)
  if (activeTab.value === tab) activeTab.value = '问答'
}

/** 节点自身或它的子孙是否对应这个标签 */
const tabBelongsTo = (tab: string, key: string): boolean => tab === key || tab.startsWith(`${key}/`)

const changeSort = (key: SortKey): void => {
  if (sortKey.value === key) {
    ascending.value = !ascending.value
  } else {
    sortKey.value = key
    ascending.value = true
  }
}

/** 文件大小展示（与上传弹窗保持一致） */
const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${bytes} B`
}

/** 时间戳 → 列表展示（今天/昨天/日期；与旧 mock 文案风格一致） */
function formatTimestamp(ts: number): string {
  if (!ts) return '—'
  const date = new Date(ts)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diffDay = Math.floor((startOfToday - date.getTime()) / 86400000)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (diffDay <= 0) return `今天 ${hm}`
  if (diffDay === 1) return `昨天 ${hm}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 扩展名 → 表格里的三套文件图标 */
const pickFileIcon = (ext: string): FileIcon => {
  if (['csv', 'xls', 'xlsx'].includes(ext)) return 'file-spreadsheet'
  if (['doc', 'docx'].includes(ext)) return 'file-type-2'
  return 'file-text'
}

/** 上传文件夹：只允许选文件夹，按 webkitRelativePath 还原原始目录结构 */
const onFolderChange = (event: Event): void => {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  // 复位，同一个文件夹可以再次选择
  input.value = ''
  if (!picked.length) return
  void addFolderUpload(picked)
}

/** 上传文件夹：按 webkitRelativePath 还原目录结构，绝对路径交主进程落盘 */
const addFolderUpload = async (picked: File[]): Promise<void> => {
  if (!selectedKbId.value) {
    notify('请先创建或选择一个知识库')
    return
  }
  let items: Array<{ srcPath: string; relPath: string }> = []
  try {
    items = picked
      .map((file) => ({
        srcPath: window.api.getPathForFile(file),
        relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      }))
      .filter((item) => !!item.srcPath)
  } catch (err) {
    notify(`读取文件路径失败：${(err as Error).message}`)
    return
  }
  if (!items.length) {
    notify('未能解析文件路径，请重新选择文件夹')
    return
  }
  const result = await kbStore.importDocuments(selectedKbId.value, items)
  notify(result ? result.message : kbStore.lastError || '上传失败')
}

/** 「上传文件」按钮：打开上传弹窗 */
const openUploadModal = (): void => {
  uploadOpen.value = true
}

/**
 * 上传弹窗确定后的落地：渲染层把 `File` 转成「绝对路径 + 相对路径」交主进程落盘。
 *
 * - Electron 39 起 `File.path` 已移除，必须走 preload 暴露的 `getPathForFile`；
 * - 索引能力未开放，统一按「只上传文件」提交（indexState = 'none'）。
 */
const onUploadSubmit = async (payload: KnowledgeUploadPayload): Promise<void> => {
  if (!selectedKbId.value) {
    notify('请先创建或选择一个知识库')
    return
  }
  let items: Array<{ srcPath: string; relPath: string }> = []
  try {
    items = payload.files
      .map((file) => ({ srcPath: window.api.getPathForFile(file), relPath: file.name }))
      .filter((item) => !!item.srcPath)
  } catch (err) {
    notify(`读取文件路径失败：${(err as Error).message}`)
    return
  }
  if (!items.length) {
    notify('未能解析文件路径，请重新选择文件')
    return
  }
  const result = await kbStore.importDocuments(selectedKbId.value, items)
  notify(result ? result.message : kbStore.lastError || '上传失败')
}

/** 「上传文件夹」按钮：只打开目录选择器（webkitdirectory 挂在输入框上） */
const uploadFolder = (): void => {
  folderUploadRef.value?.click()
}

// ── 文件行三点菜单：查看详情 / 重新命名 / 重建索引 / 创建共享 / 删除 ──
/** 鼠标移到三点按钮即滑出菜单 */
const openFileMenu = (key: string): void => {
  fileMenuKey.value = key
  libraryMenuOpen.value = false
}

/** 鼠标离开整个菜单区域（含下拉层）时收起 */
const leaveFileMenu = (key: string): void => {
  if (fileMenuKey.value === key) fileMenuKey.value = null
}

const closeFileMenu = (): void => {
  fileMenuKey.value = null
}

// ── 查看详情 ──
const detailNode = ref<KnowledgeTreeNode | null>(null)
const detailOpen = ref(false)

const detailTitle = computed(() => detailNode.value?.name ?? '')

/** 详情弹窗的信息行（文件夹与文件展示不同字段） */
const detailItems = computed<Array<{ label: string; value: string }>>(() => {
  const node = detailNode.value
  if (!node) return []
  const location = parentKeyOf(node.key) || '知识库根目录'
  if (node.kind === 'folder') {
    return [
      { label: '名称', value: node.name },
      { label: '类型', value: '文件夹' },
      { label: '包含文件', value: `${collectFileNodes(node.children ?? []).length} 个` },
      { label: '所在位置', value: location },
      { label: '索引状态', value: '随其中的文件一起建立索引' }
    ]
  }
  return [
    { label: '名称', value: node.name },
    { label: '类型', value: node.file?.type ?? '文件' },
    { label: '大小', value: node.file?.size ?? '—' },
    { label: '更新时间', value: node.file?.updated ?? '—' },
    { label: '所在位置', value: location },
    { label: '索引状态', value: indexStateText(node) }
  ]
})

const openFileDetail = (node: KnowledgeTreeNode): void => {
  closeFileMenu()
  detailNode.value = node
  detailOpen.value = true
}

// ── 重新命名（文件 / 文件夹）──
const renameTarget = ref<KnowledgeTreeNode | null>(null)
const fileRenameOpen = ref(false)

const openFileRename = (node: KnowledgeTreeNode): void => {
  closeFileMenu()
  renameTarget.value = node
  fileRenameOpen.value = true
}

/** 打开文件所在目录：主进程解析真实路径并在资源管理器中定位该文件 */
const openFileDir = async (node: KnowledgeTreeNode): Promise<void> => {
  closeFileMenu()
  if (!selectedKbId.value) return
  const ok = await kbStore.openFileDir(selectedKbId.value, node.key)
  if (!ok) notify(kbStore.lastError || '打开文件夹失败')
}

const submitFileRename = async (name: string): Promise<void> => {
  const target = renameTarget.value
  renameTarget.value = null
  if (!target || name === target.name) return
  if (!selectedKbId.value) return
  const result = await kbStore.renameDocument(selectedKbId.value, target.key, name)
  if (!result) {
    notify(kbStore.lastError || '重命名失败')
    return
  }
  // 已打开的标签页跟着改名，避免指向不存在的 key
  const remap = (tab: string): string => remapKey(tab, target.key, result.relPath)
  openTabs.value = openTabs.value.map(remap)
  if (activeTab.value !== '问答') activeTab.value = remap(activeTab.value)
  notify(`已重命名为「${name}」`)
}

// ── 重建索引（索引能力未开放：明确提示，不再做本地标记假象）──
const rebuildIndex = (node: KnowledgeTreeNode): void => {
  closeFileMenu()
  notify(`「${node.name}」的索引功能开发中，敬请期待`)
}

// ── 创建共享（知识库 / 文件夹 / 文件共用同一个弹窗）──
const shareOpen = ref(false)
const shareName = ref('')
const shareKind = ref<ShareKind>('file')

const shareTargetId = ref('')

const openShare = (name: string, kind: ShareKind, targetId = ''): void => {
  closeFileMenu()
  libraryMenuOpen.value = false
  shareName.value = name
  shareKind.value = kind
  shareTargetId.value = targetId || selectedKbId.value
  shareOpen.value = true
}

const onShareCreated = (name: string): void => {
  notify(`已创建「${name}」的共享链接`)
}

// ── 删除文件 / 文件夹：二次确认 ──
const deleteFileNode = ref<KnowledgeTreeNode | null>(null)

const askDeleteFile = (node: KnowledgeTreeNode): void => {
  closeFileMenu()
  deleteFileNode.value = node
}

const confirmDeleteFile = async (): Promise<void> => {
  const target = deleteFileNode.value
  deleteFileNode.value = null
  if (!target) return
  if (!selectedKbId.value) return
  const ok = await kbStore.removeDocument(selectedKbId.value, target.key)
  if (!ok) {
    notify(kbStore.lastError || '删除失败')
    return
  }
  openTabs.value = openTabs.value.filter((tab) => !tabBelongsTo(tab, target.key))
  if (tabBelongsTo(activeTab.value, target.key)) activeTab.value = '问答'
  notify(`已删除「${target.name}」`)
}

// ── 知识库名字右侧的操作菜单：重命名 / 创建共享 / 索引设置 / 删除 ──
const libraryRenameOpen = ref(false)

const toggleLibraryMenu = (): void => {
  libraryMenuOpen.value = !libraryMenuOpen.value
  fileMenuKey.value = null
}

const openLibraryRename = (): void => {
  libraryMenuOpen.value = false
  libraryRenameOpen.value = true
}

/** 打开知识库所在目录：路径由主进程解析并在系统文件管理器中打开 */
const openLibraryDir = async (): Promise<void> => {
  libraryMenuOpen.value = false
  if (!selectedKbId.value) {
    notify('请先创建或选择一个知识库')
    return
  }
  const ok = await kbStore.openBaseDir(selectedKbId.value)
  if (!ok) notify(kbStore.lastError || '打开文件夹失败')
}

/** 只改名称，描述沿用原值（描述编辑仍在「知识库编辑」弹窗里） */
const submitLibraryRename = async (name: string): Promise<void> => {
  libraryRenameOpen.value = false
  const target = selectedLibrary.value
  if (!target.id || name === target.name) return
  const ok = await kbStore.updateBase(target.id, { name })
  notify(ok ? `已重命名为「${name}」` : kbStore.lastError || '重命名失败')
}

const openLibrarySettingsFromHeader = (): void => {
  libraryMenuOpen.value = false
  openLibrarySettings(selectedLibrary.value)
}

const deleteLibraryFromHeader = (): void => {
  libraryMenuOpen.value = false
  askDeleteLibrary(selectedLibrary.value)
}

// ── 问答区域：折叠 / 展开 / 全屏（默认折叠 = 整块区域不显示）──
/**
 * - 折叠（默认）：整个问答区域收起不显示，知识库内容区域占满工作台，右侧只留一条展开入口
 * - 展开：重新显示问答区域（恢复拖拽出来的分栏宽度）
 * - 全屏：整块工作台都交给问答区域
 *
 * 展开 / 折叠由同一个按钮承担：收起时只显示「展开」，显示时只显示「折叠」。
 */
const togglePanelCollapsed = (): void => {
  // 全屏时点它先退出全屏，再收起区域
  if (panelFullscreen.value) {
    panelFullscreen.value = false
    panelCollapsed.value = true
    return
  }
  panelCollapsed.value = !panelCollapsed.value
}

/** 全屏 / 还原：全屏时按钮切成「还原」，还原回展开（分栏）状态 */
const togglePanelFullscreen = (): void => {
  panelFullscreen.value = !panelFullscreen.value
  // 全屏必然处于显示状态；退出全屏后回到展开的分栏宽度
  panelCollapsed.value = false
}

/** 收起时知识库内容区域占满工作台，显示时按拖拽出来的分栏比例 */
const filePanelStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {}
  if (!panelCollapsed.value) style.width = `${filePanelPercent.value}%`
  return style
})

// ── 左侧分组栏 / 右侧内容区 拖拽分栏 ──
/**
 * 拖动分组栏右侧的分割栏调整它的宽度：
 * 结果限制在 180~420px，同时给右侧内容区留出足够空间，松手后写入本地。
 */
const resizeGroups = (event: MouseEvent): void => {
  event.preventDefault()
  const workbench = (event.currentTarget as HTMLElement | null)?.parentElement
  const total = workbench?.clientWidth ?? 0
  const maxWidth = total
    ? Math.max(GROUPS_WIDTH_MIN, Math.min(GROUPS_WIDTH_MAX, total - 460))
    : GROUPS_WIDTH_MAX
  const startX = event.clientX
  const startWidth = groupsWidth.value
  const onMove = (moveEvent: MouseEvent): void => {
    groupsWidth.value = Math.min(
      maxWidth,
      Math.max(GROUPS_WIDTH_MIN, startWidth + moveEvent.clientX - startX)
    )
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    localStorage.setItem(GROUPS_WIDTH_KEY, String(groupsWidth.value))
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/** 双击分割栏恢复默认宽度 */
const resetGroupsWidth = (): void => {
  groupsWidth.value = GROUPS_WIDTH_DEFAULT
  localStorage.setItem(GROUPS_WIDTH_KEY, String(GROUPS_WIDTH_DEFAULT))
}

// ── 左侧文件区 / 右侧问答区 拖拽分栏 ──
const resizePanels = (event: MouseEvent): void => {
  event.preventDefault()
  const rect = detailRef.value?.getBoundingClientRect()
  if (!rect) return
  const onMove = (moveEvent: MouseEvent): void => {
    filePanelPercent.value = Math.min(
      65,
      Math.max(28, ((moveEvent.clientX - rect.left) / rect.width) * 100)
    )
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ── 问答提交（检索与问答能力尚未实现：明确提示，不做假回答）──
const ask = (): void => {
  if (!question.value.trim()) return
  answer.value =
    '知识库问答（检索）功能开发中：需要先完成文档解析、切片、向量化与检索链路。' +
    '当前版本可以先上传并管理资料，索引与问答将在后续版本开放。'
  question.value = ''
}

// ── 概览：统计 + 文件维度汇总（切片/实体随索引能力提供）──
const openOverview = async (): Promise<void> => {
  await kbStore.loadStats()
  overviewOpen.value = true
}

// ── 标签栏滚动按钮显隐 ──
const updateTabScroll = (): void => {
  const el = tabBarRef.value
  if (!el) return
  tabScroll.value = {
    left: el.scrollLeft > 2,
    right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2
  }
}

const moveTabs = (direction: -1 | 1): void => {
  tabBarRef.value?.scrollBy({ left: direction * 180, behavior: 'smooth' })
  window.setTimeout(updateTabScroll, 250)
}

onMounted(async () => {
  updateTabScroll()
  window.addEventListener('resize', updateTabScroll)
  document.addEventListener('mousedown', onDocumentMousedown)
  document.addEventListener('keydown', onDocumentKeydown)
  // 首屏拉取知识库列表，并加载当前选中库的文件列表
  await kbStore.loadBases()
  if (selectedKbId.value) await kbStore.loadDocuments(selectedKbId.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateTabScroll)
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('keydown', onDocumentKeydown)
  if (toastTimer) clearTimeout(toastTimer)
})
watch(openTabs, () => {
  nextTick(updateTabScroll)
})
</script>

<template>
  <div class="kb-page">
    <!-- ════════════════ 分组全部知识库（查看更多） ════════════════ -->
    <div v-if="moreGroup" class="kb-more">
      <div class="kb-more-inner">
        <div class="kb-breadcrumb">
          <button class="kb-breadcrumb-link" @click="moreGroupId = null">知识库</button>
          <svg
            class="kb-breadcrumb-sep"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span>{{ moreGroup.label }}</span>
        </div>

        <div class="kb-more-header">
          <div>
            <p class="kb-more-eyebrow">Knowledge spaces</p>
            <h1 class="kb-more-title">{{ moreGroup.label }}</h1>
            <p class="kb-more-desc">浏览、整理并调用这个分类下的全部知识库。</p>
          </div>
          <button class="kb-more-create" @click="addKnowledgeLibrary(moreGroup?.id ?? 'local')">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            新建知识库
          </button>
        </div>

        <div class="kb-more-grid">
          <button
            v-for="library in moreLibraries"
            :key="library.id"
            class="kb-lib-card"
            @click="selectFromMore(library)"
          >
            <div class="kb-lib-card-head">
              <span
                class="kb-lib-card-badge"
                :style="{ color: library.tone, background: library.tone + '14' }"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 7v14" />
                  <path
                    d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
                  />
                </svg>
              </span>
              <svg
                class="kb-lib-card-arrow"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M7 7h10v10" />
                <path d="M7 17 17 7" />
              </svg>
            </div>
            <h2 class="kb-lib-card-title">{{ library.name }}</h2>
            <p class="kb-lib-card-desc">{{ library.description }}</p>
            <div class="kb-lib-card-foot">
              <span>{{ library.files }} 份文件</span>
              <span>更新于 {{ library.updated }}</span>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- ════════════════ 知识库工作台 ════════════════ -->
    <div
      v-else
      class="kb-workbench"
      :class="{
        'kb-workbench--panel-collapsed': panelCollapsed,
        'kb-workbench--panel-full': panelFullscreen
      }"
    >
      <!-- ── 知识库分组侧栏 ── -->
      <aside class="kb-groups" :style="{ width: `${groupsWidth}px` }">
        <button class="kb-overview" @click="openOverview">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect width="7" height="9" x="3" y="3" rx="1" />
            <rect width="7" height="5" x="14" y="3" rx="1" />
            <rect width="7" height="9" x="14" y="12" rx="1" />
            <rect width="7" height="5" x="3" y="16" rx="1" />
          </svg>
          概览
        </button>

        <div class="kb-groups-list">
          <div
            v-for="group in knowledgeGroups"
            :key="group.id"
            class="kb-group"
            @mouseleave="openGroupMenu = null"
          >
            <div class="kb-group-head">
              <button class="kb-group-toggle" @click="toggleGroup(group.id)">
                <span class="kb-group-icon">
                  <svg
                    v-if="group.icon === 'hard-drive'"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="22" x2="2" y1="12" y2="12" />
                    <path
                      d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
                    />
                    <line x1="6" x2="6.01" y1="16" y2="16" />
                    <line x1="10" x2="10.01" y1="16" y2="16" />
                  </svg>
                  <svg
                    v-else-if="group.icon === 'users'"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <svg
                    v-else
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
                  </svg>
                </span>
                <span class="kb-group-label">{{ group.label }}</span>
              </button>

              <button
                class="kb-group-more"
                :title="`${group.label}操作`"
                @mouseenter="openGroupMenu = group.id"
                @click="toggleGroupMenu(group.id)"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                  <circle cx="5" cy="12" r="1" />
                </svg>
              </button>

              <button
                class="kb-group-chevron"
                :class="{ 'kb-group-chevron--collapsed': !expanded[group.id] }"
                @click="toggleGroup(group.id)"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>

            <!-- 分组操作菜单（悬浮时展开） -->
            <div
              v-if="openGroupMenu === group.id"
              class="kb-group-menu"
              @mouseenter="openGroupMenu = group.id"
            >
              <button class="kb-group-menu-item" @click="openMoreGroup(group.id)">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 7v14" />
                  <path
                    d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
                  />
                </svg>
                查看更多
              </button>
              <button class="kb-group-menu-item" @click="addKnowledgeLibrary(group.id)">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </svg>
                新建知识库
              </button>
            </div>

            <!-- 分组下的知识库列表 -->
            <div v-if="expanded[group.id]" class="kb-group-items">
              <div
                v-for="library in group.items"
                :key="library.id"
                class="kb-lib-row"
                @mouseleave="openLibMenu = null"
              >
                <button
                  class="kb-lib-item"
                  :class="{ 'kb-lib-item--active': selectedLibrary.id === library.id }"
                  @click="selectLibrary(library)"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                    />
                    <path d="M8 10v4" />
                    <path d="M12 10v2" />
                    <path d="M16 10v6" />
                  </svg>
                  <span class="kb-lib-name">{{ library.name }}</span>
                </button>

                <!-- 三点操作按钮：悬浮条目时淡入，点击展开菜单 -->
                <button
                  class="kb-lib-more"
                  type="button"
                  :title="`「${library.name}」操作`"
                  :aria-label="`「${library.name}」操作`"
                  @click="toggleLibMenu(library.id)"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                    <circle cx="5" cy="12" r="1" />
                  </svg>
                </button>

                <!-- 条目操作菜单：编辑 / 设置 / 删除 -->
                <div v-if="openLibMenu === library.id" class="kb-lib-menu">
                  <button class="kb-lib-menu-item" @click="openEditLibrary(library)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                      />
                      <path d="m15 5 4 4" />
                    </svg>
                    知识库编辑
                  </button>
                  <button class="kb-lib-menu-item" @click="openLibrarySettings(library)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path
                        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                      />
                    </svg>
                    知识库设置
                  </button>
                  <button
                    class="kb-lib-menu-item kb-lib-menu-item--danger"
                    @click="askDeleteLibrary(library)"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" x2="10" y1="11" y2="17" />
                      <line x1="14" x2="14" y1="11" y2="17" />
                    </svg>
                    知识库删除
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- ── 文件区 + 问答区 ── -->
      <!-- 分组侧栏 / 内容区 分割栏：左右拖动调整知识库侧栏宽度 -->
      <div
        class="kb-resizer kb-resizer--groups"
        title="拖动调整知识库侧栏宽度（双击恢复默认）"
        @mousedown="resizeGroups"
        @dblclick="resetGroupsWidth"
      >
        <span class="kb-resizer-bar"></span>
      </div>

      <div ref="detailRef" class="kb-detail">
        <!-- 文件区 -->
        <section class="kb-files" :style="filePanelStyle">
          <div class="kb-files-header">
            <div>
              <div class="kb-files-title-row">
                <span
                  class="kb-lib-badge"
                  :style="{
                    color: selectedLibrary.tone,
                    background: selectedLibrary.tone + '14'
                  }"
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M12 7v14" />
                    <path
                      d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"
                    />
                  </svg>
                </span>
                <h1 class="kb-files-title">{{ selectedLibrary.name }}</h1>
                <!-- 知识库操作：重命名 / 创建共享 / 索引设置 / 删除 -->
                <div class="kb-library-menu-wrap">
                  <button
                    class="kb-library-more"
                    type="button"
                    title="知识库操作"
                    aria-label="知识库操作"
                    :aria-expanded="libraryMenuOpen"
                    @click="toggleLibraryMenu"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="12" cy="12" r="1" />
                      <circle cx="19" cy="12" r="1" />
                      <circle cx="5" cy="12" r="1" />
                    </svg>
                  </button>

                  <div v-if="libraryMenuOpen" class="kb-library-menu">
                    <button class="kb-lib-menu-item" @click="openLibraryRename">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                        />
                        <path d="m15 5 4 4" />
                      </svg>
                      重命名
                    </button>
                    <button class="kb-lib-menu-item" @click="openLibraryDir">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                        />
                      </svg>
                      打开文件夹
                    </button>
                    <button
                      class="kb-lib-menu-item"
                      @click="openShare(selectedLibrary.name, 'library')"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="18" cy="5" r="3" />
                        <circle cx="6" cy="12" r="3" />
                        <circle cx="18" cy="19" r="3" />
                        <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
                        <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
                      </svg>
                      创建共享
                    </button>
                    <button class="kb-lib-menu-item" @click="openLibrarySettingsFromHeader">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="12" cy="12" r="3" />
                        <path
                          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                        />
                      </svg>
                      索引设置
                    </button>
                    <button
                      class="kb-lib-menu-item kb-lib-menu-item--danger"
                      @click="deleteLibraryFromHeader"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" x2="10" y1="11" y2="17" />
                        <line x1="14" x2="14" y1="11" y2="17" />
                      </svg>
                      删除
                    </button>
                  </div>
                </div>
              </div>
              <p class="kb-files-sub">{{ selectedLibrary.description }} · {{ fileSummary }}</p>
            </div>

            <div class="kb-files-actions">
              <!-- 上传文件夹：webkitdirectory 让系统选择器只能选目录 -->
              <input
                ref="folderUploadRef"
                type="file"
                multiple
                webkitdirectory
                class="kb-file-input"
                @change="onFolderChange"
              />
              <button class="kb-btn-ghost" @click="openUploadModal">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" x2="12" y1="3" y2="15" />
                </svg>
                上传文件
              </button>
              <button class="kb-btn-ghost" @click="uploadFolder">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                  />
                </svg>
                上传文件夹
              </button>
            </div>
          </div>

          <div class="kb-table">
            <div class="kb-table-head">
              <button class="kb-sort-btn" @click="changeSort('name')">
                名称
                <svg
                  v-if="sortKey === 'name'"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path :d="ascending ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'" />
                </svg>
              </button>
              <button class="kb-sort-btn" @click="changeSort('size')">
                大小
                <svg
                  v-if="sortKey === 'size'"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path :d="ascending ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'" />
                </svg>
              </button>
              <button class="kb-sort-btn" @click="changeSort('updated')">
                更新时间
                <svg
                  v-if="sortKey === 'updated'"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path :d="ascending ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'" />
                </svg>
              </button>
              <span class="kb-table-head-ops">操作</span>
            </div>

            <div
              v-for="row in rows"
              :key="row.node.key"
              class="kb-table-row"
              :class="{ 'kb-table-row--menu': fileMenuKey === row.node.key }"
            >
              <!-- 文件夹：点击展开 / 折叠；文件：点击在最右侧以标签页打开 -->
              <button
                v-if="row.node.kind === 'folder'"
                class="kb-file-btn kb-file-btn--folder"
                :style="{ paddingLeft: `${row.depth * 16}px` }"
                @click="toggleFolder(row.node.key)"
              >
                <svg
                  class="kb-file-chevron"
                  :class="{ 'kb-file-chevron--open': isFolderExpanded(row.node.key) }"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span class="kb-file-icon kb-file-icon--folder">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path
                      d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"
                    />
                  </svg>
                </span>
                <span class="kb-file-name">{{ row.node.name }}</span>
                <span class="kb-file-tag kb-file-tag--folder">
                  {{ collectFileNodes(row.node.children ?? []).length }} 项
                </span>
              </button>
              <button
                v-else
                class="kb-file-btn"
                :style="{ paddingLeft: `${row.depth * 16}px` }"
                @click="openFile(row.node)"
              >
                <span
                  class="kb-file-icon"
                  :style="{
                    color: row.node.file?.tint,
                    background: (row.node.file?.tint || '#168b7a') + '12'
                  }"
                >
                  <svg
                    v-if="row.node.file?.icon === 'file-text'"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                    <path d="M10 9H8" />
                    <path d="M16 13H8" />
                    <path d="M16 17H8" />
                  </svg>
                  <svg
                    v-else-if="row.node.file?.icon === 'file-type-2'"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4" />
                    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                    <path d="M2 13v-1h6v1" />
                    <path d="M5 12v6" />
                    <path d="M4 18h2" />
                  </svg>
                  <svg
                    v-else
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                    <path d="M8 13h2" />
                    <path d="M14 13h2" />
                    <path d="M8 17h2" />
                    <path d="M14 17h2" />
                  </svg>
                </span>
                <span class="kb-file-name">{{ row.node.name }}</span>
                <span
                  v-if="indexTagText(row.node)"
                  class="kb-file-tag"
                  :class="{ 'kb-file-tag--none': row.node.file?.indexState === 'none' }"
                >
                  {{ indexTagText(row.node) }}
                </span>
              </button>
              <span class="kb-file-meta">{{ row.node.file?.size ?? '—' }}</span>
              <span class="kb-file-meta">{{ row.node.file?.updated ?? '—' }}</span>

              <!-- 操作列：三个点，鼠标移上去滑出下拉菜单 -->
              <div
                class="kb-row-more"
                @mouseenter="openFileMenu(row.node.key)"
                @mouseleave="leaveFileMenu(row.node.key)"
              >
                <button
                  class="kb-row-more-btn"
                  type="button"
                  :title="`「${row.node.name}」操作`"
                  :aria-label="`「${row.node.name}」操作`"
                  @click="openFileMenu(row.node.key)"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                    <circle cx="5" cy="12" r="1" />
                  </svg>
                </button>

                <div v-if="fileMenuKey === row.node.key" class="kb-row-menu">
                  <button class="kb-lib-menu-item" @click="openFileDetail(row.node)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
                      />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    查看详情
                  </button>
                  <button class="kb-lib-menu-item" @click="openFileRename(row.node)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                      />
                      <path d="m15 5 4 4" />
                    </svg>
                    重新命名
                  </button>
                  <button class="kb-lib-menu-item" @click="openFileDir(row.node)">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path
                        d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                      />
                    </svg>
                    打开文件夹
                  </button>
                  <button
                    v-if="row.node.kind === 'file'"
                    class="kb-lib-menu-item"
                    @click="rebuildIndex(row.node)"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                      <path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                      <path d="M8 16H3v5" />
                    </svg>
                    重建索引
                  </button>
                  <button
                    class="kb-lib-menu-item"
                    @click="
                      openShare(
                        row.node.name,
                        row.node.kind === 'folder' ? 'folder' : 'file',
                        row.node.key
                      )
                    "
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
                      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
                    </svg>
                    创建共享
                  </button>
                  <button
                    class="kb-lib-menu-item kb-lib-menu-item--danger"
                    @click="askDeleteFile(row.node)"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" x2="10" y1="11" y2="17" />
                      <line x1="14" x2="14" y1="11" y2="17" />
                    </svg>
                    删除
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 分栏拖拽手柄（问答区域收起时用不到） -->
        <div
          v-if="!panelCollapsed"
          class="kb-resizer"
          title="拖动调整区域宽度"
          @mousedown="resizePanels"
        >
          <span class="kb-resizer-bar"></span>
        </div>

        <!-- 问答 / 文件预览区：折叠时整块收起，只留右侧一条展开入口 -->
        <aside v-if="!panelCollapsed" class="kb-panel">
          <div class="kb-tabs">
            <button
              class="kb-tab-scroll"
              :class="{ 'kb-tab-scroll--hidden': !tabScroll.left }"
              aria-label="向左滚动标签"
              @click="moveTabs(-1)"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <div ref="tabBarRef" class="kb-tabbar" @scroll="updateTabScroll">
              <div
                v-for="tab in openTabs"
                :key="tab"
                class="kb-tab"
                :class="{ 'kb-tab--active': activeTab === tab }"
              >
                <button class="kb-tab-name" @click="activeTab = tab">{{ tabLabel(tab) }}</button>
                <button v-if="tab !== '问答'" class="kb-tab-close" @click="closeTab(tab)">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <button
              class="kb-tab-scroll"
              :class="{ 'kb-tab-scroll--hidden': !tabScroll.right }"
              aria-label="向右滚动标签"
              @click="moveTabs(1)"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>

            <!-- 问答区域（最右侧）右上角：展开 / 折叠 + 全屏 / 还原（默认折叠） -->
            <div class="kb-panel-actions">
              <!-- 折叠：整个问答区域收起，用指向右侧的单箭头（与右栏「收起右栏」一致） -->
              <button
                class="kb-panel-btn kb-panel-btn--active"
                type="button"
                title="折叠"
                aria-label="折叠问答区域"
                :aria-expanded="true"
                @click="togglePanelCollapsed"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <button
                class="kb-panel-btn"
                :class="{ 'kb-panel-btn--active': panelFullscreen }"
                type="button"
                :title="panelFullscreen ? '还原' : '全屏'"
                :aria-label="panelFullscreen ? '还原问答区域' : '全屏显示问答区域'"
                :aria-pressed="panelFullscreen"
                @click="togglePanelFullscreen"
              >
                <!-- 还原：四角向内（退出全屏） -->
                <svg
                  v-if="panelFullscreen"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"
                  />
                </svg>
                <!-- 全屏：四角向外 -->
                <svg
                  v-else
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
                  />
                </svg>
              </button>
            </div>
          </div>

          <!-- 问答 -->
          <div v-if="activeTab === '问答'" class="kb-tab-content">
            <div class="kb-qa-banner">
              <p class="kb-qa-eyebrow">KNOWLEDGE Q&amp;A</p>
              <h2 class="kb-qa-title">向 {{ selectedLibrary.name }} 提问</h2>
              <p class="kb-qa-desc">检索与问答功能开发中，将在索引能力完成后开放。</p>
            </div>

            <div v-if="answer" class="kb-answer">{{ answer }}</div>

            <div class="kb-question-wrap">
              <div class="kb-qinput">
                <textarea
                  v-model="question"
                  rows="2"
                  class="kb-qinput-textarea"
                  placeholder="基于知识库提问"
                  @keydown.enter.exact.prevent="ask"
                ></textarea>
                <div class="kb-qinput-foot">
                  <button class="kb-model-btn">
                    DS 快速
                    <svg
                      class="kb-model-caret"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  <div class="kb-qinput-actions">
                    <button class="kb-icon-btn" title="添加附件">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M13.234 20.252 21 12.3" />
                        <path
                          d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"
                        />
                      </svg>
                    </button>
                    <button class="kb-icon-btn" title="快捷剪裁">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <circle cx="6" cy="6" r="3" />
                        <path d="M8.12 8.12 12 12" />
                        <path d="M20 4 8.12 15.88" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M14.8 14.8 20 20" />
                      </svg>
                    </button>
                    <button
                      class="kb-send-btn"
                      title="发送问题"
                      :disabled="!question.trim()"
                      @click="ask"
                    >
                      <svg
                        width="17"
                        height="17"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
                        />
                        <path d="m21.854 2.147-10.94 10.939" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 文件预览标签：只渲染文件内容本身（文件名/图标/元信息不在此处重复展示） -->
          <div v-else class="kb-file-tab">
            <FilePreviewPane v-if="previewSource" :source="previewSource" />
            <p v-else class="kb-preview-notice">在左侧文件列表中点击文件即可预览内容。</p>
          </div>
        </aside>
        <aside v-else class="kb-panel-strip">
          <button
            class="kb-panel-btn kb-panel-strip-btn"
            type="button"
            title="展开"
            aria-label="展开问答区域"
            :aria-expanded="false"
            @click="togglePanelCollapsed"
          >
            <!-- 展开：把问答区域从左拉出显示，用单箭头指向左侧 -->
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span class="kb-panel-strip-label">问答</span>
        </aside>
      </div>
    </div>

    <!-- 知识库编辑 / 按库设置弹窗 + 删除确认 -->
    <KnowledgeEditModal
      :open="editOpen"
      :library="editLibrary"
      @close="editOpen = false"
      @saved="saveLibraryEdit"
    />
    <KnowledgeSettingsModal
      :open="settingsOpen"
      :library="settingsLibrary"
      @close="settingsOpen = false"
      @saved="onLibrarySettingsSaved"
    />
    <KnowledgeUploadModal
      :open="uploadOpen"
      :library="selectedLibrary"
      @close="uploadOpen = false"
      @submit="onUploadSubmit"
    />
    <ConfirmDialog
      v-if="deleteCandidate"
      title="删除知识库"
      :message="`确定删除「${deleteCandidate.name}」吗？该知识库的按库设置会一并清除，此操作不可撤销。`"
      confirm-text="删除"
      @confirm="confirmDeleteLibrary"
      @cancel="deleteCandidate = null"
    />
    <ConfirmDialog
      v-if="deleteFileNode"
      title="删除文件"
      :message="`确定删除「${deleteFileNode.name}」吗？${
        deleteFileNode.kind === 'folder' ? '该文件夹及其中的文件会' : '该文件会'
      }从当前知识库移除，此操作不可撤销。`"
      confirm-text="删除"
      @confirm="confirmDeleteFile"
      @cancel="deleteFileNode = null"
    />
    <KnowledgeDetailModal
      :open="detailOpen"
      :title="detailTitle"
      :items="detailItems"
      @close="detailOpen = false"
    />
    <KnowledgeRenameModal
      :open="fileRenameOpen"
      :current="renameTarget?.name ?? ''"
      title="重新命名"
      :hint="
        renameTarget?.kind === 'folder'
          ? '重命名文件夹后，其中文件的路径会一起更新。'
          : '重命名后，列表与预览标签页中的名称会同步更新。'
      "
      @close="fileRenameOpen = false"
      @submit="submitFileRename"
    />
    <KnowledgeRenameModal
      :open="libraryRenameOpen"
      :current="selectedLibrary.name"
      title="重命名知识库"
      label="知识库名称"
      hint="重命名只改显示名称，知识库中的文件与索引设置不受影响。"
      @close="libraryRenameOpen = false"
      @submit="submitLibraryRename"
    />
    <KnowledgeShareModal
      :open="shareOpen"
      :target-name="shareName"
      :target-kind="shareKind"
      :target-id="shareTargetId"
      @close="shareOpen = false"
      @created="onShareCreated"
    />

    <!-- 新建知识库 / 概览 -->
    <KnowledgeCreateModal
      :open="createOpen"
      :kind="createKind"
      @close="createOpen = false"
      @submit="onCreateLibrary"
    />
    <KnowledgeOverviewModal
      :open="overviewOpen"
      :stats="kbStore.stats"
      :libraries="kbStore.bases"
      @close="overviewOpen = false"
    />

    <!-- 轻量 toast -->
    <div v-if="toast" class="kb-toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   知识库 —— 页面骨架
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-page {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: hidden;
  background: #fbfcfc;
}

.kb-workbench {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

.kb-toast {
  position: absolute;
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

/* ═══════════════════════════════════════════════════════════════════════════
   左侧：知识库分组
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-groups {
  width: 250px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 24px 12px;
  background: #f6f9f8;
  border-right: 1px solid #e2ebe7;
  scrollbar-width: none;
}
.kb-groups::-webkit-scrollbar {
  display: none;
}

.kb-overview {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 12px;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 500;
  background: #e5f3ef;
  color: #147967;
  border: none;
  font-family: inherit;
  cursor: pointer;
}

.kb-groups-list {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kb-group {
  position: relative;
}

.kb-group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding: 6px 8px;
}
.kb-group-head:hover {
  background: #edf4f1;
}

.kb-group-toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
}
.kb-group-icon {
  display: flex;
  color: #718087;
}
.kb-group-label {
  font-size: 12px;
  font-weight: 500;
  color: #425157;
}

.kb-group-more {
  display: flex;
  border-radius: 4px;
  padding: 4px;
  color: #668078;
  background: transparent;
  border: none;
  opacity: 0;
  transition: opacity 0.15s;
  cursor: pointer;
}
.kb-group:hover .kb-group-more {
  opacity: 1;
}
.kb-group-more:hover {
  background: #ffffff;
  color: #168b7a;
}

.kb-group-chevron {
  display: flex;
  padding: 4px;
  color: #718087;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-group-chevron--collapsed {
  transform: rotate(-90deg);
}

.kb-group-menu {
  position: absolute;
  right: 20px;
  top: 36px;
  z-index: 30;
  width: 126px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}
.kb-group-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: #405258;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-group-menu-item:hover {
  background: #f1f7f4;
}

.kb-group-items {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 1px solid #dce8e4;
  padding-left: 8px;
}

/* 条目行：选择按钮 + 悬浮出现的操作按钮（同级按钮，避免 button 嵌套） */
.kb-lib-row {
  position: relative;
  margin-bottom: 2px;
  min-width: 0;
}

.kb-lib-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  /* 右侧给操作按钮预留：名称可用宽度恒定，悬浮时不重排 */
  padding: 6px 28px 6px 10px;
  text-align: left;
  font-family: inherit;
  background: transparent;
  color: #66757b;
  border: none;
  cursor: pointer;
}
.kb-lib-item:hover {
  background: #edf4f1;
}
/* 选中态必须与 :hover 同列写：否则 .kb-lib-item:hover 特异性更高会把选中色盖掉 */
.kb-lib-item--active,
.kb-lib-item--active:hover {
  background: #ddf0ea;
  color: #147967;
}
.kb-lib-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 三点操作按钮（悬浮淡入，对齐 .kb-group-more） */
.kb-lib-more {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  padding: 3px;
  border-radius: 4px;
  color: #668078;
  background: transparent;
  border: none;
  opacity: 0;
  transition: opacity 0.15s;
  cursor: pointer;
}
.kb-lib-row:hover .kb-lib-more,
.kb-lib-more:focus-visible {
  opacity: 1;
}
.kb-lib-more:hover {
  background: #ffffff;
  color: #168b7a;
}

/* 条目操作菜单（视觉对齐 .kb-group-menu） */
.kb-lib-menu {
  position: absolute;
  right: 4px;
  top: 28px;
  z-index: 30;
  width: 132px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}
.kb-lib-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: #405258;
  background: transparent;
  border: none;
  cursor: pointer;
}
.kb-lib-menu-item:hover {
  background: #f1f7f4;
}
.kb-lib-menu-item--danger {
  color: #cf625b;
}
.kb-lib-menu-item--danger:hover {
  background: #fdeeee;
}

/* ═══════════════════════════════════════════════════════════════════════════
   右侧：文件区
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-detail {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.kb-files {
  min-width: 320px;
  overflow-y: auto;
  padding: 28px;
  scrollbar-width: none;
}
.kb-files::-webkit-scrollbar {
  display: none;
}

.kb-files-header {
  margin-bottom: 24px;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.kb-files-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kb-lib-badge {
  display: flex;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}
.kb-files-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: #17252b;
}
.kb-files-sub {
  margin: 8px 0 0;
  font-size: 12px;
  color: #748187;
}
.kb-files-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.kb-file-input {
  display: none;
}
.kb-btn-ghost {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 12px;
  border: 1px solid #dfe9e5;
  background: #ffffff;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #49616a;
  cursor: pointer;
}

/* ── 文件表格 ── */
.kb-table {
  /* 行内三点菜单要溢出显示，圆角改由表头与末行兜住 */
  overflow: visible;
  border-radius: 16px;
  border: 1px solid #e1ebe7;
  background: #ffffff;
}
.kb-table-head {
  border-radius: 16px 16px 0 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 100px 36px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #edf2f0;
  background: #f8faf9;
  padding: 12px 20px;
  font-size: 12px;
  font-weight: 500;
  color: #718087;
}
.kb-sort-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
  cursor: pointer;
}

.kb-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 100px 36px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #f0f4f2;
  padding: 12px 20px;
}
.kb-table-row:hover {
  background: #f7faf9;
}
.kb-file-btn {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
}
.kb-file-icon {
  display: flex;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.kb-file-name {
  font-size: 12px;
  font-weight: 500;
  color: #34454b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-file-tag {
  flex-shrink: 0;
  border-radius: 999px;
  background: #e5f3ef;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  color: #147967;
}
.kb-file-tag--none {
  background: #f1f3f4;
  color: #8a969a;
}
.kb-file-meta {
  font-size: 11px;
  color: #879498;
}
.kb-file-del {
  display: flex;
  border-radius: 6px;
  padding: 4px;
  color: #b3bfc1;
  background: transparent;
  border: none;
  opacity: 0;
  cursor: pointer;
}
.kb-table-row:hover .kb-file-del {
  opacity: 1;
}
.kb-file-del:hover {
  background: #fdeeee;
  color: #cf625b;
}

/* ── 知识库名字右侧的操作按钮与下拉菜单 ── */
.kb-library-menu-wrap {
  position: relative;
  display: flex;
}
.kb-library-more {
  display: flex;
  padding: 5px;
  border-radius: 8px;
  border: 1px solid #dfe9e5;
  background: #ffffff;
  color: #668078;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.kb-library-more:hover {
  border-color: #168b7a;
  color: #168b7a;
}
.kb-library-menu {
  position: absolute;
  left: 0;
  top: 34px;
  z-index: 40;
  width: 132px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}

/* ── 文件夹行 / 操作列 / 行内三点菜单 ── */
.kb-table-head-ops {
  text-align: right;
}
.kb-table-row--menu {
  position: relative;
  z-index: 20;
}
.kb-table-row:last-child {
  border-radius: 0 0 16px 16px;
}
.kb-file-btn--folder {
  gap: 8px;
}
.kb-file-chevron {
  flex-shrink: 0;
  color: #8a969a;
  transition: transform 0.15s ease;
}
.kb-file-chevron:not(.kb-file-chevron--open) {
  transform: rotate(-90deg);
}
.kb-file-icon--folder {
  color: #f59e0b;
  background: #fef5e7;
}
.kb-file-tag--folder {
  background: #f1f3f4;
  color: #8a969a;
}
.kb-row-more {
  position: relative;
  display: flex;
  justify-content: flex-end;
}
.kb-row-more-btn {
  display: flex;
  padding: 4px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #b3bfc1;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.kb-table-row:hover .kb-row-more-btn {
  color: #668078;
}
.kb-row-more-btn:hover {
  background: #edf4f1;
  color: #168b7a;
}
.kb-row-menu {
  position: absolute;
  right: 0;
  top: 26px;
  z-index: 40;
  width: 132px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #e1e9e6;
  background: #ffffff;
  padding: 4px 0;
  box-shadow: 0 8px 22px rgba(24, 58, 51, 0.14);
}

/* ── 最右侧区域右上角：展开 / 折叠 / 全屏 ── */
.kb-panel-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  margin-left: 4px;
  border-left: 1px solid #e6eeeb;
  padding-left: 8px;
}
.kb-panel-btn {
  display: flex;
  padding: 5px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #8a969a;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.kb-panel-btn:hover {
  background: #edf4f1;
  color: #168b7a;
}
.kb-panel-btn--active {
  border-color: #cfe6df;
  background: #e5f3ef;
  color: #147967;
}

/* 折叠（默认）：整块问答区域收起不显示，知识库内容区域占满工作台 */
.kb-workbench--panel-collapsed .kb-files {
  width: auto;
  min-width: 0;
  flex: 1 1 auto;
}
/* 收起后右侧只留一条展开入口，保证还能重新展开 */
.kb-panel-strip {
  display: flex;
  width: 44px;
  flex-shrink: 0;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  border-left: 1px solid #e6eeeb;
  background: #f7faf9;
  padding: 12px 0;
}
.kb-panel-strip-label {
  writing-mode: vertical-rl;
  font-size: 12px;
  letter-spacing: 0.18em;
  color: #879498;
}

/* 全屏：整块工作台交给最右侧区域 */
.kb-workbench--panel-full .kb-groups,
.kb-workbench--panel-full .kb-files,
.kb-workbench--panel-full .kb-resizer {
  display: none;
}
/* ── 分栏拖拽手柄 ── */
.kb-resizer {
  position: relative;
  z-index: 10;
  display: flex;
  width: 1px;
  flex-shrink: 0;
  cursor: col-resize;
  align-items: center;
  justify-content: center;
  background: #dfe9e5;
}
.kb-resizer:hover {
  background: #168b7a;
}
.kb-resizer-bar {
  position: absolute;
  height: 40px;
  width: 4px;
  border-radius: 9999px;
  background: #b8cdc6;
  opacity: 0;
  transition: opacity 0.15s;
}
.kb-resizer:hover .kb-resizer-bar {
  opacity: 1;
}
/* 左侧分组栏分隔条：热区加宽到 6px 更好拖，视觉上仍是一条细线 */
.kb-resizer--groups {
  width: 6px;
  margin-right: -3px;
  margin-left: -3px;
  background: transparent;
}
.kb-resizer--groups:hover {
  background: rgba(22, 139, 122, 0.12);
}

/* ═══════════════════════════════════════════════════════════════════════════
   右侧：问答 / 文件预览面板
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-panel {
  min-width: 350px;
  flex: 1;
  overflow: hidden;
  background: #ffffff;
  display: flex;
  flex-direction: column;
}

/* ── 标签栏 ── */
.kb-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #e6eeeb;
  padding: 0 8px;
}
.kb-tab-scroll {
  display: flex;
  flex-shrink: 0;
  border-radius: 4px;
  padding: 4px;
  color: #718087;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s;
}
.kb-tab-scroll:hover {
  background: #edf4f1;
}
.kb-tab-scroll--hidden {
  pointer-events: none;
  opacity: 0;
}
.kb-tabbar {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-tabbar::-webkit-scrollbar {
  display: none;
}
.kb-tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  border-bottom: 2px solid transparent;
  padding: 12px;
  font-size: 12px;
  color: #758287;
}
.kb-tab--active {
  border-bottom-color: #168b7a;
  color: #147967;
}
.kb-tab-name {
  max-width: 148px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
}
.kb-tab-close {
  display: flex;
  border-radius: 4px;
  padding: 2px;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
}
.kb-tab-close:hover {
  background: #eff5f2;
}

/* ── 问答 ── */
.kb-tab-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 20px;
}
.kb-qa-banner {
  border-radius: 12px;
  border: 1px solid #d7ebe3;
  background: #edf7f3;
  padding: 16px;
}
.kb-qa-eyebrow {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: #168b7a;
}
.kb-qa-title {
  margin: 8px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #24433d;
}
.kb-qa-desc {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 20px;
  color: #55716a;
}
.kb-answer {
  margin-top: 20px;
  border-radius: 12px;
  background: #f7faf9;
  padding: 16px;
  font-size: 12px;
  line-height: 24px;
  color: #42575a;
}
.kb-question-wrap {
  margin-top: auto;
  padding-top: 20px;
}

/* ── 提问输入框 ── */
.kb-qinput {
  border-radius: 24px;
  border: 1px solid #d9dfdd;
  background: #ffffff;
  padding: 12px;
  box-shadow: 0 1px 2px rgba(20, 44, 39, 0.03);
}
.kb-qinput:focus-within {
  border-color: #8dbfb3;
}
.kb-qinput-textarea {
  width: 100%;
  resize: none;
  background: transparent;
  border: none;
  padding: 2px 4px 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  color: #31454a;
  outline: none;
}
.kb-qinput-textarea::placeholder {
  color: #b7bec0;
}
.kb-qinput-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.kb-model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 9999px;
  border: 1px solid #e1e6e4;
  background: #fbfcfc;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #4d5b60;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-model-btn:hover {
  background: #f0f6f3;
}
.kb-model-caret {
  color: #8a9598;
}
.kb-qinput-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-icon-btn {
  display: flex;
  border-radius: 8px;
  padding: 6px;
  color: #1d2b30;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-icon-btn:hover {
  background: #eef5f2;
}
.kb-send-btn {
  margin-left: 4px;
  display: flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s;
}
.kb-send-btn:disabled {
  background: #c8ccce;
  color: #ffffff;
  cursor: default;
}
.kb-send-btn:not(:disabled) {
  background: #168b7a;
  color: #ffffff;
}
.kb-send-btn:not(:disabled):hover {
  background: #117764;
}

/* ── 文件预览标签：容器不额外加装饰，内容占满整块区域 ── */
.kb-file-tab {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

/* ═══════════════════════════════════════════════════════════════════════════
   查看更多：分组下的全部知识库
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-more {
  flex: 1;
  overflow-y: auto;
  background: #fbfcfc;
  padding: 32px;
  scrollbar-width: none;
}
.kb-more::-webkit-scrollbar {
  display: none;
}
.kb-more-inner {
  max-width: 1152px;
  margin: 0 auto;
}
.kb-breadcrumb {
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #7b8792;
}
.kb-breadcrumb-link {
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
  cursor: pointer;
}
.kb-breadcrumb-link:hover {
  color: #168b7a;
}
.kb-breadcrumb-sep {
  flex-shrink: 0;
}
.kb-more-header {
  margin-bottom: 28px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}
.kb-more-eyebrow {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: #168b7a;
}
.kb-more-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #17252b;
}
.kb-more-desc {
  margin: 8px 0 0;
  font-size: 13px;
  color: #718087;
}
.kb-more-create {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 12px;
  background: #168b7a;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  color: #ffffff;
  border: none;
  cursor: pointer;
}
.kb-more-grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 16px;
}
@media (min-width: 768px) {
  .kb-more-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (min-width: 1280px) {
  .kb-more-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.kb-lib-card {
  border-radius: 16px;
  border: 1px solid #e6eeeb;
  background: #ffffff;
  padding: 20px;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}
.kb-lib-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 30px rgba(18, 67, 61, 0.08);
}
.kb-lib-card-head {
  margin-bottom: 28px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.kb-lib-card-badge {
  display: flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}
.kb-lib-card-arrow {
  color: #aab5b7;
}
.kb-lib-card:hover .kb-lib-card-arrow {
  color: #168b7a;
}
.kb-lib-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #1d2c31;
}
.kb-lib-card-desc {
  margin: 6px 0 0;
  min-height: 40px;
  font-size: 12px;
  line-height: 20px;
  color: #77848a;
}
.kb-lib-card-foot {
  margin-top: 20px;
  display: flex;
  justify-content: space-between;
  border-top: 1px solid #eff3f1;
  padding-top: 12px;
  font-size: 11px;
  color: #8a969a;
}

/* ═══════════════════════════════════════════════════════════════════════════
   窄窗口兜底
   Figma 原始约束（文件区 40% + min-width:320px、问答区 min-width:350px、
   文件名列 minmax(0,1fr)）在窗口宽度不足时会让文件名列塌成 0px、
   问答区被 overflow 裁切。以下仅在窄窗口放宽硬最小宽并给文件名列下限，
   窗口 ≥1700px 时渲染结果与设计逐像素一致。
   ═══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1699px) {
  .kb-table-head,
  .kb-table-row {
    grid-template-columns: minmax(132px, 1fr) 64px 84px 32px;
  }
  /* 文件区至少容纳「文件名 + 大小 + 更新时间 + 删除」四列，避免横向溢出 */
  .kb-files {
    min-width: 456px;
  }
  /* 问答区改为随剩余空间收缩，不再撑破 .kb-detail 被裁切 */
  .kb-panel {
    min-width: 0;
  }
}

@media (max-width: 1199px) {
  .kb-table-head,
  .kb-table-row {
    grid-template-columns: minmax(88px, 1fr) 52px 72px 28px;
  }
  .kb-files {
    min-width: 372px;
  }
  /* 极窄下输入框底部按钮改为换行，避免撑出问答区 */
  .kb-qinput-foot {
    flex-wrap: wrap;
    gap: 6px;
  }
}
/* ═══════════════════════════════════════════════════════════════════════════
   文件预览（文本 / Markdown / 图片）
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-preview-notice {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--kw-color-text-muted);
}

</style>
