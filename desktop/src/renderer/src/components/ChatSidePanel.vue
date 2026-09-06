<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@store/workspace'
import { useAgentStore } from '@store/agent'
import FileList from './FileList.vue'
import FilePreview from './FilePreview.vue'
import BrowserPanel from './BrowserPanel.vue'
import type { Workspace, WorkspaceFileEntry } from '../../../preload/index.d'

const WordEditor = defineAsyncComponent(() => import('./WordEditor.vue'))
const PdfPreview = defineAsyncComponent(() => import('./PdfPreview.vue'))

const props = defineProps<{ fullscreen: boolean; ratioMode?: boolean }>()
const emit = defineEmits<{
  (e: 'update:fullscreen', v: boolean): void
  (e: 'ratio-exit'): void
}>()

const workspaceStore = useWorkspaceStore()
const agentStore = useAgentStore()

type ViewKey = 'overview' | 'files' | 'browser'

// ── 状态 ──
const open = ref(false) // 收起右栏（默认收缩，顶部只显示展开按钮）
const view = ref<ViewKey>('overview')
const viewMenuOpen = ref(false)
const artifactsOpen = ref(false)

/** 选中文件（含内容预览） */
interface Selection {
  entry: WorkspaceFileEntry
  content: string
  truncated: boolean
  loading?: boolean
}

/** 文件标签页（工作空间文件视图；顶栏标签条展示） */
interface FileTab {
  key: string // relPath，同文件去重键
  entry: WorkspaceFileEntry
  kind: 'text' | 'word' | 'pdf'
  content: string
  truncated: boolean
  document?: Uint8Array
  wordMode: 'view' | 'edit'
  loading: boolean
  error: string
  /** 文档产物流关联 id（openArtifact 创建；按 id 接收 chunk/end） */
  artifactId?: string
  /** 二进制产物生成中（doc/docx/pdf 落盘前占位） */
  artifactPending?: boolean
  /** 文本产物流式渲染中 */
  streaming?: boolean
}
const fileTabs = ref<FileTab[]>([])
const activeTabKey = ref<string | null>(null)
const activeTab = computed(() => fileTabs.value.find((t) => t.key === activeTabKey.value) ?? null)

const artifactsSelection = ref<Selection | null>(null)
const browserPanelRef = ref<{
  openWorkspaceFile: (workspaceId: string, relPath: string) => Promise<void>
} | null>(null)

/** 由内嵌浏览器直接预览的工作空间文件类型。 */
const BROWSER_EXTENSIONS = new Set([
  'html',
  'htm',
  'svg',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp'
])

const viewLabels: Record<ViewKey, string> = {
  overview: '概览',
  files: '工作空间文件',
  browser: '浏览器'
}

// ── 数据源：会话绑定工作空间优先，当前选择兜底（与主进程"绑定优先"权威行为一致）──
const panelWorkspace = computed<Workspace | null>(() => {
  const bound = agentStore.currentConversation?.workspace
  if (bound?.id) {
    return workspaceStore.workspaces.find((w) => w.id === bound.id) ?? null
  }
  return workspaceStore.currentWorkspace
})

const panelWorkspaceId = computed(() => panelWorkspace.value?.id ?? null)

const sourceLabel: Record<Workspace['source'], string> = {
  created: '新建',
  external: '本地文件夹',
  timestamp: '临时',
  default: '默认'
}

/** 会话概要 */
function getExt(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ''
}

const conversationSummary = computed(() => {
  const conv = agentStore.currentConversation
  const createAt = conv?.createAt ? formatDateTime(conv.createAt) : ''
  return {
    title: conv?.title ?? '新对话',
    createAt,
    messageCount: agentStore.currentMessages.length
  }
})

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── 视图切换下拉 ──
const switchView = (key: ViewKey): void => {
  void window.api.browserSetVisible(open.value && key === 'browser')
  view.value = key
  viewMenuOpen.value = false
}

/** 网格图标：工作空间文件视图开关。标签页内容预览中先收起预览回到文件树（标签保留在顶栏），
 *  文件树展示中切回进入文件视图前的视图 */
const lastNonFilesView = ref<ViewKey>('overview')
const toggleFilesView = (): void => {
  if (view.value !== 'files') {
    // 从其他视图进入：记住来源视图，展示文件树（不残留上一个标签页内容）
    lastNonFilesView.value = view.value
    activeTabKey.value = null
    view.value = 'files'
  } else if (activeTab.value) {
    // 标签页内容预览中：收起预览回到文件树
    activeTabKey.value = null
  } else {
    // 文件树展示中：切回进入前的视图
    view.value = lastNonFilesView.value
  }
  viewMenuOpen.value = false
}

// 外部点击关闭下拉
const handleDocumentClick = (e: MouseEvent): void => {
  const target = e.target as HTMLElement
  if (!target.closest('[data-view-menu-trigger]') && !target.closest('.csp-view-menu')) {
    viewMenuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentClick)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleDocumentClick)
})

/** 文件树点击：已开标签则激活，否则新建标签并读取内容 */
async function openInBrowser(entry: WorkspaceFileEntry): Promise<void> {
  if (!panelWorkspaceId.value) return
  view.value = 'browser'
  open.value = true
  await nextTick()
  await browserPanelRef.value?.openWorkspaceFile(panelWorkspaceId.value, entry.relPath)
}

async function openFile(entry: WorkspaceFileEntry): Promise<void> {
  const ext = getExt(entry.name)
  if (BROWSER_EXTENSIONS.has(ext)) {
    try {
      await openInBrowser(entry)
      return
    } catch (err) {
      console.error('[ChatSidePanel] open in browser failed:', err)
      if (ext === 'pdf') {
        await openLegacyFile(entry)
        return
      }
      return
    }
  }
  await openLegacyFile(entry)
}

async function openLegacyFile(entry: WorkspaceFileEntry): Promise<void> {
  if (fileTabs.value.some((t) => t.key === entry.relPath)) {
    activeTabKey.value = entry.relPath
    return
  }
  fileTabs.value.push({
    key: entry.relPath,
    entry,
    kind: 'text',
    content: '',
    truncated: false,
    document: undefined,
    wordMode: 'view',
    loading: true,
    error: ''
  })
  activeTabKey.value = entry.relPath
  try {
    const tab = fileTabs.value.find((t) => t.key === entry.relPath)
    if (!tab) return

    if (getExt(entry.name) === 'doc' || getExt(entry.name) === 'docx') {
      tab.kind = 'word'
      const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
      tab.document = result.bytes
    } else if (getExt(entry.name) === 'pdf') {
      tab.kind = 'pdf'
      const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
      tab.document = result.bytes
    } else {
      const result = await workspaceStore.readFile(panelWorkspaceId.value!, entry.relPath)
      tab.content = result.content
      tab.truncated = result.truncated
    }
    tab.error = ''
    tab.loading = false
  } catch (err) {
    const tab = fileTabs.value.find((t) => t.key === entry.relPath)
    if (tab) {
      tab.error = err instanceof Error ? `读取失败：${err.message}` : '读取失败：未知错误'
      tab.loading = false
    }
  }
}

/** 产物区：保持旧的内联预览行为（不接入标签页） */
async function saveActiveWord(bytes: ArrayBuffer): Promise<void> {
  const tab = activeTab.value
  if (!tab || !panelWorkspaceId.value) return

  try {
    await workspaceStore.saveFile(panelWorkspaceId.value, tab.entry.relPath, bytes)
    tab.error = ''
  } catch (err) {
    tab.error = err instanceof Error ? `保存失败：${err.message}` : '保存失败：未知错误'
  }
}

async function openArtifactFile(entry: WorkspaceFileEntry): Promise<void> {
  artifactsSelection.value = { entry, content: '', truncated: false, loading: true }
  try {
    const result = await workspaceStore.readFile(panelWorkspaceId.value!, entry.relPath)
    artifactsSelection.value = { entry, content: result.content, truncated: result.truncated }
  } catch (err) {
    artifactsSelection.value = {
      entry,
      content: `读取失败：${err instanceof Error ? err.message : '未知错误'}`,
      truncated: false
    }
  }
}

function activateTab(key: string): void {
  view.value = 'files'
  activeTabKey.value = key
}

/** 关闭标签：关闭激活标签时激活相邻（优先右侧），全部关闭回到文件树 */
function closeTab(key: string): void {
  const idx = fileTabs.value.findIndex((t) => t.key === key)
  if (idx === -1) return
  fileTabs.value.splice(idx, 1)
  if (activeTabKey.value === key) {
    const next = fileTabs.value[idx] ?? fileTabs.value[idx - 1]
    activeTabKey.value = next ? next.key : null
  }
}

function closeArtifactsSelection(): void {
  artifactsSelection.value = null
}

// 工作空间切换时清空标签与选中
watch(panelWorkspaceId, () => {
  fileTabs.value = []
  activeTabKey.value = null
  artifactsSelection.value = null
  artifactsOpen.value = false
})

watch([open, view], () => {
  void window.api.browserSetVisible(open.value && view.value === 'browser')
})

// ── 拖拽分割线（调整右栏宽度；localStorage 持久化）──
const PANEL_WIDTH_KEY = 'ke-work.panel-width'
const PANEL_WIDTH_MIN = 240
const initialWidth = Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 300
const panelWidth = ref(
  Math.min(Math.min(600, window.innerWidth * 0.6), Math.max(PANEL_WIDTH_MIN, initialWidth))
)
const dragging = ref(false)

/** 拖拽分割线：mousedown 后跟随鼠标，钳制 [240, min(600, 60% 窗口)]；全屏态禁用 */
function startDrag(e: MouseEvent): void {
  if (props.fullscreen) return
  // 文档 5:5 比例态下用户主动拖拽 → 退出比例态，改由像素宽度接管
  if (props.ratioMode) emit('ratio-exit')
  e.preventDefault()
  dragging.value = true
  const onMove = (ev: MouseEvent): void => {
    const max = Math.min(600, window.innerWidth * 0.6)
    panelWidth.value = Math.min(max, Math.max(PANEL_WIDTH_MIN, window.innerWidth - ev.clientX))
  }
  const onUp = (): void => {
    dragging.value = false
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value))
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── 收起 / 全屏 ──
const toggleFullscreen = (): void => {
  emit('update:fullscreen', !props.fullscreen)
}

/** 收起右栏：全屏态先退全屏再收起，避免空白态 */
const collapsePanel = (): void => {
  if (props.fullscreen) {
    emit('update:fullscreen', false)
  }
  if (props.ratioMode) emit('ratio-exit')
  open.value = false
  void window.api.browserSetVisible(false)
}

/** 展开右栏（收起态顶部展开按钮） */
const expandPanel = (): void => {
  open.value = true
  void window.api.browserSetVisible(view.value === 'browser')
}

/** 按相对路径打开工作区文档（消息链接/文件卡片点击；已开标签则聚焦） */
async function openDocFileByRelPath(relPath: string, opts?: { name?: string }): Promise<void> {
  if (!panelWorkspaceId.value) {
    console.warn('[ChatSidePanel] no workspace for doc open:', relPath)
    return
  }
  open.value = true
  view.value = 'files'
  const name = opts?.name ?? relPath.split('/').pop() ?? relPath
  await openFile({ name, relPath, type: 'file' })
}

/** 打开正在生成的文档产物（自动展开右侧栏；文本型流式接收 chunk，word/pdf 等 end 后读字节） */
async function openArtifact(
  meta: { artifactId: string; name: string; relPath: string; preview: string },
  initialText?: string
): Promise<void> {
  if (!panelWorkspaceId.value) return
  open.value = true
  view.value = 'files'
  let tab = fileTabs.value.find((item) => item.key === meta.relPath)
  const kind =
    meta.preview === 'word' || meta.preview === 'pdf'
      ? (meta.preview as 'word' | 'pdf')
      : ('text' as const)
  if (!tab) {
    fileTabs.value.push({
      key: meta.relPath,
      entry: { name: meta.name, relPath: meta.relPath, type: 'file' },
      kind,
      content: initialText ?? '',
      truncated: false,
      document: undefined,
      wordMode: 'view',
      loading: false,
      error: '',
      artifactId: meta.artifactId,
      artifactPending: kind !== 'text',
      streaming: kind === 'text'
    })
  } else {
    tab.content = initialText ?? ''
    tab.document = undefined
    tab.error = ''
    tab.loading = false
    tab.artifactId = meta.artifactId
    tab.artifactPending = tab.kind !== 'text'
    tab.streaming = tab.kind === 'text'
  }
  activeTabKey.value = meta.relPath
}

function appendArtifactText(artifactId: string, text: string): void {
  const tab = fileTabs.value.find((item) => item.artifactId === artifactId)
  if (!tab) return
  tab.content += text
}

/** 产物流结束：文本型收尾（html 切浏览器渲染）；word/pdf 读字节后交给对应组件 */
async function finishArtifact(artifactId: string, ok: boolean, error?: string): Promise<void> {
  const idx = fileTabs.value.findIndex((item) => item.artifactId === artifactId)
  if (idx === -1) return
  const tab = fileTabs.value[idx]
  tab.artifactId = undefined
  tab.artifactPending = false
  tab.streaming = false
  if (!ok) {
    tab.error = error ?? '文档生成失败'
    return
  }
  const entry = tab.entry
  const ext = getExt(entry.name)
  if (ext === 'html' || ext === 'htm') {
    // 源码已流式展示完毕，切换到浏览器渲染（与工作空间模式下打开 html 一致）
    fileTabs.value.splice(idx, 1)
    if (activeTabKey.value === tab.key) {
      activeTabKey.value = fileTabs.value[idx]?.key ?? fileTabs.value[idx - 1]?.key ?? null
    }
    if (panelWorkspaceId.value) {
      view.value = 'browser'
      await nextTick()
      await browserPanelRef.value?.openWorkspaceFile(panelWorkspaceId.value, entry.relPath)
    }
    return
  }
  if (tab.content) return
  try {
    if (tab.kind === 'word' || tab.kind === 'pdf') {
      const result = await workspaceStore.readFileBytes(panelWorkspaceId.value!, entry.relPath)
      tab.document = result.bytes
    } else {
      const result = await workspaceStore.readFile(panelWorkspaceId.value!, entry.relPath)
      tab.content = result.content
      tab.truncated = result.truncated
    }
  } catch (err) {
    tab.error = err instanceof Error ? '读取失败：' + err.message : '读取失败'
  }
}

defineExpose({
  openArtifact,
  openDocFileByRelPath,
  appendArtifactText,
  finishArtifact,
  collapse: collapsePanel
})
</script>

<template>
  <aside
    :class="[
      'csp',
      {
        'csp--collapsed': !open,
        'csp--fullscreen': fullscreen,
        'csp--dragging': dragging,
        'csp--ratio': ratioMode
      }
    ]"
    :style="open && !fullscreen ? { width: `${panelWidth}px` } : undefined"
  >
    <!-- 拖拽分割线手柄（左缘；收起/全屏态不渲染） -->
    <div
      v-if="open && !fullscreen"
      class="csp-resizer"
      title="拖动调整宽度"
      @mousedown="startDrag"
    ></div>
    <!-- 顶部按钮栏：收起态只显示展开按钮 -->
    <div class="csp-topbar">
      <template v-if="open">
        <!-- 视图切换（网格图标 = 文件视图开关，箭头 = 下拉菜单触发；靠左对齐） -->
        <div class="csp-view-wrap" data-view-menu-trigger>
          <button
            class="csp-icon-btn csp-view-trigger"
            :class="{ 'csp-view-trigger--active': view === 'files' }"
            title="工作空间文件"
            @click="toggleFilesView"
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
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            class="csp-icon-btn csp-view-trigger"
            :class="{ 'csp-view-trigger--active': viewMenuOpen }"
            title="切换视图"
            @click="viewMenuOpen = !viewMenuOpen"
          >
            <svg
              :class="['csp-view-chevron', { 'csp-view-chevron--open': viewMenuOpen }]"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <Transition name="dropdown">
            <div v-if="viewMenuOpen" class="csp-view-menu">
              <button
                v-for="(label, key) in viewLabels"
                :key="key"
                :class="['csp-view-menu-item', { 'csp-view-menu-item--active': view === key }]"
                @click="switchView(key as ViewKey)"
              >
                <svg
                  v-if="view === key"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span v-else class="csp-view-menu-gap"></span>
                {{ label }}
              </button>
            </div>
          </Transition>
        </div>
        <!-- 文件标签条（与「收起右栏」按钮同行） -->
        <div v-if="fileTabs.length" class="csp-tabs">
          <button
            v-for="tab in fileTabs"
            :key="tab.key"
            :class="['csp-tab', { 'csp-tab--active': tab.key === activeTabKey }]"
            :title="tab.entry.relPath"
            @click="activateTab(tab.key)"
          >
            <span class="csp-tab-name">{{ tab.entry.name }}</span>
            <span class="csp-tab-close" title="关闭" @click.stop="closeTab(tab.key)">×</span>
          </button>
        </div>
        <button
          class="csp-icon-btn"
          :title="fullscreen ? '退出全屏' : '全屏'"
          @click="toggleFullscreen"
        >
          <svg
            v-if="!fullscreen"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path
              d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
            />
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
          >
            <path
              d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"
            />
          </svg>
        </button>
        <button class="csp-icon-btn" title="收起右栏" @click="collapsePanel">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </template>
      <button v-else class="csp-icon-btn csp-expand-btn" title="展开右侧" @click="expandPanel">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <template v-if="open">
      <!-- 视图体 -->
      <div
        :class="['csp-body', { 'csp-body--browser-fullscreen': fullscreen && view === 'browser' }]"
      >
        <!-- 概览 -->
        <template v-if="view === 'overview'">
          <template v-if="panelWorkspace">
            <div class="csp-card">
              <p class="csp-card-name">{{ panelWorkspace.name }}</p>
              <p class="csp-card-path" :title="panelWorkspace.path">{{ panelWorkspace.path }}</p>
              <div class="csp-card-meta">
                <span class="csp-source">{{ sourceLabel[panelWorkspace.source] }}</span>
                <button class="csp-open" @click="workspaceStore.open(panelWorkspace.id)">
                  打开文件夹
                </button>
              </div>
            </div>
            <div class="csp-card">
              <p class="csp-card-sub">当前会话</p>
              <p class="csp-card-title">{{ conversationSummary.title }}</p>
              <p class="csp-card-line">创建时间：{{ conversationSummary.createAt }}</p>
              <p class="csp-card-line">消息数：{{ conversationSummary.messageCount }}</p>
            </div>
            <p class="csp-hint">当前任务的工作文件夹：智能体将在此目录读写文件、生成产物</p>
          </template>
          <div v-else class="csp-empty">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            >
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
            </svg>
            <p class="csp-empty-title">未选择工作空间</p>
            <p class="csp-empty-hint">前往「新建任务」输入框下方选择工作空间</p>
          </div>
        </template>

        <!-- 工作空间文件 -->
        <template v-else-if="view === 'files'">
          <div v-if="activeTab" class="csp-view-body">
            <p v-if="activeTab.loading" class="csp-empty-tip">加载中…</p>
            <p v-else-if="activeTab.error" class="csp-load-error">{{ activeTab.error }}</p>
            <p v-else-if="activeTab.artifactPending" class="csp-empty-tip">生成中…</p>
            <WordEditor
              v-else-if="activeTab.kind === 'word' && activeTab.document"
              v-model:mode="activeTab.wordMode"
              :document="activeTab.document"
              :title="activeTab.entry.name"
              @save="saveActiveWord"
            />
            <PdfPreview
              v-else-if="activeTab.kind === 'pdf' && activeTab.document"
              :document="activeTab.document"
              :name="activeTab.entry.name"
            />
            <FilePreview
              v-else
              :name="activeTab.entry.name"
              :rel-path="activeTab.entry.relPath"
              :content="activeTab.content"
              :truncated="activeTab.truncated"
              :workspace-id="panelWorkspaceId ?? undefined"
              :show-back="false"
            />
          </div>
          <div v-else-if="panelWorkspaceId" class="csp-view-body">
            <FileList :workspace-id="panelWorkspaceId" @open-file="openFile" />
          </div>
          <p v-else class="csp-empty-tip">未选择工作空间</p>
        </template>

        <!-- 浏览器 -->
        <template v-else>
          <BrowserPanel ref="browserPanelRef" :fullscreen="fullscreen" />
        </template>
      </div>

      <!-- 产物区（常驻） -->
      <div v-if="!fullscreen && view !== 'browser'" class="csp-artifacts">
        <button
          class="csp-artifact-head"
          data-artifact-toggle
          @click="artifactsOpen = !artifactsOpen"
        >
          <span>产物</span>
          <svg
            :class="['csp-artifact-chevron', { 'csp-artifact-chevron--open': artifactsOpen }]"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <Transition name="space-collapse">
          <div v-show="artifactsOpen" class="csp-artifact-body">
            <div v-if="artifactsSelection" class="csp-view-body csp-view-body--artifacts">
              <FilePreview
                :name="artifactsSelection.entry.name"
                :rel-path="artifactsSelection.entry.relPath"
                :content="artifactsSelection.content"
                :truncated="artifactsSelection.truncated"
                :workspace-id="panelWorkspaceId ?? undefined"
                @back="closeArtifactsSelection"
              />
            </div>
            <div v-else-if="panelWorkspaceId" class="csp-view-body csp-view-body--artifacts">
              <!-- key 变化保证每次展开/换空间时 FileList 重新加载根列表 -->
              <FileList
                :key="`${panelWorkspaceId}-${artifactsOpen}`"
                :workspace-id="panelWorkspaceId"
                @open-file="openArtifactFile"
              />
            </div>
            <p v-else class="csp-empty-tip">未选择工作空间</p>
          </div>
        </Transition>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.csp {
  position: relative;
  flex-shrink: 0;
  border-left: 1px solid rgba(8, 145, 178, 0.1);
  background: var(--kw-color-bg-soft);
  display: flex;
  flex-direction: column;
  min-height: 0;
  transition: width 0.25s ease;
  user-select: none;
}

/* 文档 5:5 比例态：覆盖像素宽度（inline style 由 !important 让位；用户拖拽即退出该态） */
.csp--ratio {
  width: 50% !important;
  flex: 0 0 50% !important;
}

.csp--fullscreen {
  width: 100%;
  flex: 1;
}

/* 收起态：40px 窄条，只显示展开按钮 */
.csp--collapsed {
  width: 40px;
  overflow: hidden;
}

.csp--collapsed .csp-topbar {
  justify-content: center;
  padding: 10px 0 4px;
}

.csp-expand-btn {
  color: var(--kw-color-brand);
}

/* 顶部按钮栏 */
.csp-topbar {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  padding: 10px 12px 4px;
  flex-shrink: 0;
}

.csp-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--kw-color-text-faint);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.csp-icon-btn:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.csp-view-chevron {
  color: var(--kw-color-text-faint);
  transition: transform 0.2s ease;
}

.csp-view-chevron--open {
  transform: rotate(180deg);
}

/* 视图切换按钮组（顶栏行内；靠左对齐分割栏，其余按钮组挤到右缘） */
.csp-view-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: auto;
}

.csp-view-trigger--active {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.csp-view-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 150px;
  padding: 6px 0;
  border-radius: 12px;
  background: var(--kw-color-surface);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  border: 1px solid var(--kw-color-border-brand);
  z-index: 30;
}

.csp-view-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--kw-color-text-secondary);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.csp-view-menu-item:hover {
  background: var(--kw-color-brand-soft);
}

.csp-view-menu-item--active {
  color: var(--kw-color-brand);
}

.csp-view-menu-item svg {
  color: var(--kw-color-brand);
  flex-shrink: 0;
}

.csp-view-menu-gap {
  width: 11px;
  flex-shrink: 0;
}

/* 下拉菜单滑出过渡 */
.dropdown-enter-active,
.dropdown-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 视图体 */
.csp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 全屏 + 浏览器视图：让浏览器内核真正铺满最大化区域（工具栏仍保留在顶部） */
.csp-body--browser-fullscreen {
  padding: 0;
  gap: 0;
  overflow: hidden;
}

.csp-view-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.csp-view-body--artifacts {
  min-height: 160px;
  max-height: 240px;
}

/* 概览卡片 */
.csp-card {
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.csp-card-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kw-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.csp-card-path {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--kw-color-text-subtle);
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.csp-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.csp-source {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  flex-shrink: 0;
}

.csp-open {
  padding: 4px 10px;
  border: none;
  border-radius: 8px;
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.15s ease;
}

.csp-open:hover {
  background: var(--kw-color-brand-soft);
}

.csp-card-sub {
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--kw-color-text-faint);
}

.csp-card-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--kw-color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.csp-card-line {
  margin: 0;
  font-size: 12px;
  color: var(--kw-color-text-secondary);
}

.csp-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--kw-color-text-subtle);
  flex-shrink: 0;
}

.csp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  color: #cbd5e1;
  text-align: center;
  flex-shrink: 0;
}

.csp-empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-muted);
}

.csp-empty-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--kw-color-text-subtle);
}

.csp-empty-tip {
  margin: 0;
  padding: 20px 8px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
  text-align: center;
}

/* 产物区 */
.csp-artifacts {
  border-top: 1px solid var(--kw-color-border-brand);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  max-height: 40%;
}

.csp-artifact-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: var(--kw-color-text);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease;
}

.csp-artifact-head:hover {
  background: var(--kw-color-brand-hover);
}

.csp-artifact-head span {
  flex: 1;
}

.csp-artifact-chevron {
  color: var(--kw-color-text-faint);
  transition: transform 0.2s ease;
}

.csp-artifact-chevron--open {
  transform: rotate(180deg);
}

.csp-artifact-body {
  padding: 0 8px 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Space collapse transition（产物展开） */
.space-collapse-enter-active,
.space-collapse-leave-active {
  transition:
    opacity 0.2s ease,
    max-height 0.25s ease;
  max-height: 400px;
  overflow: hidden;
}

.space-collapse-enter-from,
.space-collapse-leave-to {
  opacity: 0;
  max-height: 0;
}

/* 文件标签条 */
.csp-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.csp-tabs::-webkit-scrollbar {
  display: none;
}

.csp-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 160px;
  padding: 3px 8px;
  border: 1px solid var(--kw-color-border-brand);
  border-radius: 8px;
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.csp-tab:hover {
  background: var(--kw-color-brand-hover);
}

.csp-tab--active {
  background: var(--kw-color-brand-soft);
  border-color: rgba(8, 145, 178, 0.3);
  color: var(--kw-color-brand);
}

.csp-tab-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.csp-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1;
  color: var(--kw-color-text-subtle);
  flex-shrink: 0;
}

.csp-tab-close:hover {
  background: var(--kw-color-brand-soft);
  color: var(--kw-color-brand-strong);
}

.csp-load-error {
  margin: 0;
  padding: 20px 8px;
  font-size: 12px;
  color: var(--kw-color-danger);
  text-align: center;
}

@media (max-width: 768px) {
  .csp {
    display: none;
  }
}

/* 拖拽分割线 */
.csp--dragging {
  transition: none;
  cursor: col-resize;
}

.csp-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
}

.csp-resizer:hover::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: var(--kw-color-border-brand);
}
</style>
