<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { showToast } from '@renderer/composables/useToast'
import {
  type KnowledgeFolder
} from '../components/knowledge/knowledgeList'
import { findNode, type KnowledgeNode } from '../components/knowledge/knowledgeTree'
import {
  createCloudKnowledgeFileSource,
  createKnowledgeFileSource
} from '../components/file-preview/sources'
import { useCloudDocs } from '@renderer/composables/useCloudDocs'
import { useKbUploads } from '@renderer/composables/useKbUploads'
import { useKbLayout } from '@renderer/composables/useKbLayout'
import { useKbQa } from '@renderer/composables/useKbQa'
import { useKbFileOps } from '@renderer/composables/useKbFileOps'
import { useKbGroups } from '@renderer/composables/useKbGroups'
import { useKbLibraryOps } from '@renderer/composables/useKbLibraryOps'
import { useKbFiles } from '@renderer/composables/useKbFiles'
import { useKbDocOps } from '@renderer/composables/useKbDocOps'
import KbModalsHost from '../components/knowledge/KbModalsHost.vue'
import KbSidebarGroups from '../components/knowledge/KbSidebarGroups.vue'
import KbMoreList from '../components/knowledge/KbMoreList.vue'
import KbFileTree from '../components/knowledge/KbFileTree.vue'
import KbDetailPanel from '../components/knowledge/KbDetailPanel.vue'
import { useCloudKnowledgeStore } from '../store/cloudKnowledge'
import { useKnowledgeStore } from '../store/knowledge'

// ── 知识库数据模型（知识库列表见 components/knowledge/knowledgeList.ts，文件树见 knowledgeTree.ts） ──
/** 文件元信息（列表行与右侧预览标签页共用） */
type KnowledgeTreeNode = KnowledgeNode

// ── 侧栏分组与选中知识库（数据来自 store；渲染层只持 ID 与相对路径）──
const kbStore = useKnowledgeStore()
const cloudKbStore = useCloudKnowledgeStore()
/** 当前打开的云知识库（非空时工作台的文件区改渲染云端文档，外壳与本地一致） */
const cloudKb = ref<KnowledgeFolder | null>(null)
/** 概览弹窗 */
const overviewOpen = ref(false)

/** 空态占位：没有知识库时详情区仍可渲染（只做属性读取） */
const EMPTY_LIBRARY: KnowledgeFolder = {
  id: '',
  name: '知识库',
  description: '还没有知识库，可从分组菜单新建',
  files: 0,
  updated: '—',
  tone: '#168b7a',
  pinned: false,
  source: 'local'
}

/** 当前选中的知识库（详情区与所有动作都基于它） */
const selectedLibrary = computed<KnowledgeFolder>(() => {
  const base = kbStore.selectedBase
  return base ? toFolder(base) : EMPTY_LIBRARY
})

// ── 知识库条目三点菜单与三个弹窗 ──

// ── 文件列表：文件树、排序、上传、标签页 ──
/** 当前选中知识库 ID（无知识库时为空串） */
const selectedKbId = computed(() => kbStore.selectedBase?.id ?? '')

// ── 本地文件树与文件夹展开（R6 外提至 composables/useKbFiles；树由文档 relPath 还原）──
const filesApi = useKbFiles({ selectedKbId })
const { fileTree, folderExpanded } = filesApi

// ── 云知识库：在同一套工作台里渲染（R6 外提至 composables/useCloudDocs）──
const cloudApi = useCloudDocs({
  cloudKb,
  notify: (text) => notify(text),
  onCloudSwitch: (id) => {
    if (!id) {
      if (!openTabs.value.includes('问答')) openTabs.value = ['问答', ...openTabs.value]
      activeTab.value = '问答'
      return
    }
    folderExpanded.value = {}
    // 云库是只读浏览：没有问答标签，标签从零开始（点文档再生成）
    openTabs.value = []
    activeTab.value = ''
    pipelineTarget.value = null
  },
  closeFileMenu: () => {
    fileMenuKey.value = null
  }
})
const { cloudDocIds, isCloudView, cloudTree } = cloudApi

/** 头部与子标题展示的库：云库与本地库共用同一套模板 */
const displayLibrary = computed(() => cloudKb.value ?? selectedLibrary.value)

/** 当前渲染的树：本地或云端（下游 computed 与模板只看它） */
const activeTree = computed(() => (isCloudView.value ? cloudTree.value : fileTree.value))

/** 标签页以文件 key 标识（'问答' 是常驻标签） */
const openTabs = ref<string[]>(['问答'])
const activeTab = ref('问答')

// ── 布局：分栏拖拽 / 问答折叠 / 标签栏滚动（R6 外提至 composables/useKbLayout；元素 ref 由本页持有注入）──
const tabBarRef = ref<HTMLElement | null>(null)
/** 文件区容器元素 ref（问答分栏拖拽参考矩形；元素 ref 由本页持有，useKbLayout 经参数注入） */
const detailRef = ref<HTMLElement | null>(null)
// ── 文件上传（R6 外提至 composables/useKbUploads；元素 ref 由本页持有并注入）──
/** 上传文件夹仍走系统目录选择 */
const folderUploadRef = ref<HTMLInputElement | null>(null)
const uploadsApi = useKbUploads({
  selectedKbId,
  notify: (text) => notify(text),
  folderUploadRef
})
/**
 * 元素 ref 的传递方盒：`folderUploadRef`/`tabBarRef` 由本页创建并注入组合件，
 * 继续传给子组件时要装进普通对象 —— 直接 `:x="someRef"` 会被模板自动解包成值。
 */
const elementRefs = { folderUploadRef, tabBarRef }

const {
  groupsWidth,
  resizeGroups,
  resetGroupsWidth,
  panelCollapsed,
  panelFullscreen,
  togglePanelCollapsed,
  togglePanelFullscreen,
  filePanelStyle,
  resizePanels,
  tabScroll,
  updateTabScroll,
  moveTabs
} = useKbLayout({ detailRef, tabBarRef, openTabs })

/**
 * 「索引进度」伪标签：key 与显示名同为该字符串（tabLabel 对此 key 早退）。
 * 与根目录中恰好同名的文件共享 key 的碰撞可接受，不做额外编码。
 */
const INDEX_TAB = '索引进度'
/** 流水线面板指向的文档（kbId + relPath）；组件按此从 store 实时取行 */
const pipelineTarget = ref<{ kbId: string; relPath: string } | null>(null)
/** 文件行三点菜单当前展开的 key */
const fileMenuKey = ref<string | null>(null)
/** 知识库名字右侧的操作菜单是否展开 */
const libraryMenuOpen = ref(false)

/** 当前标签对应的节点（'问答' 不是节点，返回 null） */
const activeNode = computed(() => findNode(activeTree.value, activeTab.value))

/** 标签页显示名：文件重命名后跟着更新（索引进度伪标签直接用标签名） */
const tabLabel = (tab: string): string => {
  if (tab === INDEX_TAB) return INDEX_TAB
  return findNode(activeTree.value, tab)?.name ?? tab
}

/** 「查看更多」页的视图模式：卡片 / 表格，记忆在本地（与分组宽度同一套本地偏好） */
const MORE_VIEW_KEY = 'ke-work.kb-more-view'
const moreViewMode = ref<'card' | 'table'>(
  localStorage.getItem(MORE_VIEW_KEY) === 'table' ? 'table' : 'card'
)

// ── 知识库分组（R6 外提至 composables/useKbGroups；云库切换/进度标签/当前标签经 Ref 注入）──
const groupsApi = useKbGroups({
  cloudKb,
  selectedLibraryId: selectedKbId,
  moreViewMode,
  pipelineTarget,
  activeTab,
  closeIndexTab: () => closeTab(INDEX_TAB),
  closeLibMenu: () => {
    openLibMenu.value = null
  },
  notify: (text) => notify(text)
})

const { toFolder, moreGroup, openGroupMenu } = groupsApi

/** 右上角切换按钮：卡片 ⇄ 表格 */
function toggleMoreView(): void {
  moreViewMode.value = moreViewMode.value === 'card' ? 'table' : 'card'
  localStorage.setItem(MORE_VIEW_KEY, moreViewMode.value)
}

// ── 知识库条目操作（R6 外提至 composables/useKbLibraryOps）──
const libraryOpsApi = useKbLibraryOps({
  openTabs,
  activeTab,
  pipelineTarget,
  notify: (text) => notify(text)
})

const {
  openLibMenu,
  openLibrarySettings,
  askDeleteLibrary,
} = libraryOpsApi

// ── 轻量提示与事件退订函数 ──
/** 索引进度事件退订函数 */
let offIndexProgress: (() => void) | null = null
/** 问答事件退订函数 */
let offAskEvents: (() => void) | null = null
const notify = (text: string): void => showToast(text)

// ── 知识库条目操作（三点菜单：编辑 / 设置 / 删除）──
/** 点击菜单以外的区域关闭菜单（侧栏条目菜单 / 文件行菜单 / 知识库操作菜单） */
const onDocumentMousedown = (event: MouseEvent): void => {
  const element = event.target instanceof Element ? event.target : null
  if (openLibMenu.value && !element?.closest('.kb-lib-row')) openLibMenu.value = null
  if (fileMenuKey.value && !element?.closest('.kb-row-more')) fileMenuKey.value = null
  if (libraryMenuOpen.value && !element?.closest('.kb-library-menu-wrap')) {
    libraryMenuOpen.value = false
  }
  // 分组菜单现在也能由「点行」打开，因此点空白处同样要关掉它
  if (openGroupMenu.value && !element?.closest('.kb-group')) openGroupMenu.value = null
  // 问答模型下拉在 KbDetailPanel 内，开关仍由本页全局监听统一关闭（组合件 API 直取）
  if (qaApi.qaModelMenuOpen.value && !element?.closest('.kb-model-wrap')) {
    qaApi.qaModelMenuOpen.value = false
  }
}

const onDocumentKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return
  openLibMenu.value = null
  fileMenuKey.value = null
  libraryMenuOpen.value = false
  openGroupMenu.value = null
  // 问答区域全屏时按 Esc = 退出全屏，回到展开的分栏宽度
  if (panelFullscreen.value) {
    panelFullscreen.value = false
    panelCollapsed.value = false
  }
}

// ── 文件夹展开 / 文件标签页 ──
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
/** 当前文件标签对应的预览来源（null = 未选中文件）；本地与云端各一套自加载来源 */
const previewSource = computed(() => {
  const node = activeNode.value
  if (!node || node.kind !== 'file') return null

  if (isCloudView.value) {
    const kb = cloudKb.value
    const docId = cloudDocIds.value[node.key]
    if (!kb || !docId) return null
    return createCloudKnowledgeFileSource(kb.id, { id: docId, name: node.name, relPath: node.key })
  }

  const kbId = selectedKbId.value
  if (!kbId) return null
  return createKnowledgeFileSource(kbId, { name: node.name, relPath: node.key })
})

const closeTab = (tab: string): void => {
  openTabs.value = openTabs.value.filter((item) => item !== tab)
  if (activeTab.value === tab) activeTab.value = '问答'
  // 关闭流水线标签时同步清目标，避免下次打开时残留旧文档
  if (tab === INDEX_TAB) pipelineTarget.value = null
}

/** 节点自身或它的子孙是否对应这个标签 */

// ── 索引进度流水线（点状态单元格 → 右侧「索引进度」标签页）──
/** 只有本地文件行能打开（云行只读、文件夹无索引；云行状态格保持惰性） */
const canOpenPipeline = (node: KnowledgeTreeNode): boolean =>
  !isCloudView.value && node.kind === 'file' && !!selectedKbId.value

/** 打开/关闭某文档的索引进度标签（与 web 一致：同文档再点一次 = 关闭） */
const openPipeline = (node: KnowledgeTreeNode): void => {
  if (!canOpenPipeline(node)) return
  if (activeTab.value === INDEX_TAB && pipelineTarget.value?.relPath === node.key) {
    closeTab(INDEX_TAB)
    return
  }
  // 与 openFile 一致：确保右侧面板展开，否则标签藏在收起的面板里
  panelCollapsed.value = false
  pipelineTarget.value = { kbId: selectedKbId.value, relPath: node.key }
  if (!openTabs.value.includes(INDEX_TAB)) openTabs.value = [...openTabs.value, INDEX_TAB]
  activeTab.value = INDEX_TAB
}

/** 时间戳 → 列表展示（今天/昨天/日期；与旧 mock 文案风格一致） */
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

// ── 查看详情 / 重新命名 / 打开所在目录（R6 外提至 composables/useKbFileOps）──
const fileOpsApi = useKbFileOps({
  selectedKbId,
  openTabs,
  activeTab,
  pipelineTarget,
  notify: (text) => notify(text),
  closeFileMenu: () => closeFileMenu()
})

/** 知识库头部菜单开关（与文件行菜单互斥；两个菜单状态由页面持有） */
const toggleLibraryMenu = (): void => {
  libraryMenuOpen.value = !libraryMenuOpen.value
  fileMenuKey.value = null
}

// ── 文档与库头部变更操作（R6 外提至 composables/useKbDocOps）──
const docOpsApi = useKbDocOps({
  selectedKbId,
  selectedLibrary,
  openTabs,
  activeTab,
  pipelineTarget,
  closeFileMenu: () => closeFileMenu(),
  closeIndexTab: () => closeTab(INDEX_TAB),
  closeLibraryHeaderMenu: () => {
    libraryMenuOpen.value = false
  },
  openLibrarySettings: (library) => openLibrarySettings(library),
  askDeleteLibrary: (library) => askDeleteLibrary(library),
  notify: (text) => notify(text)
})

// ── 知识库问答（R6 外提至 composables/useKbQa；引用跳转经 openByRelPath 回调）──
const qaApi = useKbQa({
  selectedKbId,
  notify: (text) => notify(text),
  openByRelPath: (relPath) => {
    const node = findNode(activeTree.value, relPath)
    if (!node) return false
    openFile(node)
    return true
  }
})

// ── 概览：统计 + 文件维度汇总（切片/实体随索引能力提供）──
const openOverview = async (): Promise<void> => {
  await kbStore.loadStats()
  overviewOpen.value = true
}

onMounted(async () => {
  updateTabScroll()
  window.addEventListener('resize', updateTabScroll)
  document.addEventListener('mousedown', onDocumentMousedown)
  document.addEventListener('keydown', onDocumentKeydown)
  // 索引进度事件：局部 patch 当前库的文档行（终态时 store 会自行全量刷新）
  offIndexProgress = kbStore.subscribeIndexProgress()
  // 问答事件：引用/增量/结束/错误（流式回答）
  offAskEvents = kbStore.subscribeAsk()
  // 首屏拉取知识库列表，并加载当前选中库的文件列表
  await kbStore.loadBases()
  if (selectedKbId.value) await kbStore.loadDocuments(selectedKbId.value)
  // 云分组并行拉取：未授权只会得到 auth-required 状态（不弹浏览器），渲染层给「去授权」入口
  void cloudKbStore.loadAll()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateTabScroll)
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('keydown', onDocumentKeydown)
  offIndexProgress?.()
  offAskEvents?.()
})
// 索引过程的非致命告警（如图谱抽取失败）必须让用户看见——绝不静默
watch(
  () => kbStore.indexWarning,
  (warning) => {
    if (!warning) return
    notify(warning)
    kbStore.indexWarning = ''
  }
)
</script>

<template>
  <div class="kb-page">
    <!-- ════════════════ 分组全部知识库（查看更多） ════════════════ -->
    <div
      class="kb-workbench"
      :class="{
        'kb-workbench--panel-collapsed': panelCollapsed,
        'kb-workbench--panel-full': panelFullscreen
      }"
    >
      <!-- ── 知识库分组侧栏（R6 外提组件 KbSidebarGroups：注入组合件 API） ── -->
      <KbSidebarGroups
        :groups="groupsApi"
        :library-ops="libraryOpsApi"
        :groups-width="groupsWidth"
        @open-overview="openOverview"
      />

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
        <!-- ── 「查看更多」视图（R6 外提组件 KbMoreList：注入组合件 API；视图模式持久化留在本页） ── -->
        <KbMoreList
          v-if="moreGroup"
          :groups="groupsApi"
          :view-mode="moreViewMode"
          :cloud-loading="cloudKbStore.loading"
          @toggle-view="toggleMoreView"
        />

        <template v-else>
          <!-- ── 文件区（R6 外提组件 KbFileTree：注入组合件 API 与页面持有的视图态） ── -->
          <KbFileTree
            :active-tree="activeTree"
            :display-library="displayLibrary"
            :selected-library="selectedLibrary"
            :cloud="cloudApi"
            :files="filesApi"
            :uploads="uploadsApi"
            :file-ops="fileOpsApi"
            :doc-ops="docOpsApi"
            :file-panel-style="filePanelStyle"
            :element-refs="elementRefs"
            :file-menu-key="fileMenuKey"
            :library-menu-open="libraryMenuOpen"
            :open-file="openFile"
            :open-pipeline="openPipeline"
            :can-open-pipeline="canOpenPipeline"
            :open-file-menu="openFileMenu"
            :leave-file-menu="leaveFileMenu"
            :toggle-library-menu="toggleLibraryMenu"
          />

          <!-- 分栏拖拽手柄（问答区域收起时用不到） -->
          <div
            v-if="!panelCollapsed"
            class="kb-resizer"
            title="拖动调整区域宽度"
            @mousedown="resizePanels"
          >
            <span class="kb-resizer-bar"></span>
          </div>

          <!-- ── 问答 / 文件预览区（R6 外提组件 KbDetailPanel：注入组合件 API 与脊柱态） ── -->
          <KbDetailPanel
            v-model:active-tab="activeTab"
            :panel-collapsed="panelCollapsed"
            :panel-fullscreen="panelFullscreen"
            :toggle-panel-collapsed="togglePanelCollapsed"
            :toggle-panel-fullscreen="togglePanelFullscreen"
            :tab-scroll="tabScroll"
            :update-tab-scroll="updateTabScroll"
            :move-tabs="moveTabs"
            :open-tabs="openTabs"
            :tab-label="tabLabel"
            :close-tab="closeTab"
            :index-tab="INDEX_TAB"
            :pipeline-target="pipelineTarget"
            :preview-source="previewSource"
            :qa="qaApi"
            :library-name="selectedLibrary.name"
            :qa-rounds="kbStore.qaRounds"
            :clear-qa-history="kbStore.clearQaHistory"
            :element-refs="elementRefs"
          />
        </template>
      </div>
    </div>

    <!-- 弹窗宿主（R6 外提组件 KbModalsHost：注入各组合件 API，13 个弹窗集中绑定） -->
    <KbModalsHost
      :library-ops="libraryOpsApi"
      :uploads="uploadsApi"
      :doc-ops="docOpsApi"
      :file-ops="fileOpsApi"
      :groups="groupsApi"
      :selected-library="selectedLibrary"
      :selected-kb-id="selectedKbId"
      :overview-open="overviewOpen"
      :stats="kbStore.stats"
      :bases="kbStore.bases"
      @close-overview="overviewOpen = false"
    />
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

/* ═══════════════════════════════════════════════════════════════════════════
   左侧：知识库分组
   ═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   右侧：文件区
   ═══════════════════════════════════════════════════════════════════════════ */
.kb-detail {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

/* 折叠（默认）：整块问答区域收起不显示，知识库内容区域占满工作台 */
.kb-workbench--panel-collapsed .kb-files {
  width: auto;
  min-width: 0;
  flex: 1 1 auto;
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

</style>
