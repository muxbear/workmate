<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import KnowledgeEditModal from '../components/knowledge/KnowledgeEditModal.vue'
import KnowledgeSettingsModal from '../components/knowledge/KnowledgeSettingsModal.vue'
import KnowledgeUploadModal from '../components/knowledge/KnowledgeUploadModal.vue'
import {
  findGroupIdOf,
  pickSelectionAfterRemoval,
  removeLibrary,
  renameLibrary,
  type KnowledgeFolder,
  type KnowledgeGroup
} from '../components/knowledge/knowledgeList'
import { uploadResultText, type KnowledgeUploadPayload } from '../components/knowledge/uploadIndex'
import { useKnowledgeSettingsStore } from '../store/knowledgeSettings'

// ── 知识库数据模型（KnowledgeFolder / KnowledgeGroup 见 components/knowledge/knowledgeList.ts） ──
type FileIcon = 'file-text' | 'file-type-2' | 'file-spreadsheet'
/** 文件建立索引的方式（undefined = 页面初始数据，按「已建立索引」展示） */
type FileIndexState = 'default' | 'custom' | 'none'
interface KnowledgeFile {
  name: string
  type: string
  size: string
  updated: string
  icon: FileIcon
  tint: string
  /** 该文件的索引方式：默认索引 / 自定义索引 / 只上传未索引 */
  indexState?: FileIndexState
}
type SortKey = 'name' | 'size' | 'updated'

// ── 知识库分组（本地 / 共享 / 云端） ──
const KNOWLEDGE_GROUPS: KnowledgeGroup[] = [
  {
    id: 'local',
    label: '本地知识库',
    icon: 'hard-drive',
    items: [
      {
        id: 'product',
        name: '产品资料库',
        description: '产品规划、需求与用户研究沉淀',
        files: 28,
        updated: '今天 10:24',
        tone: '#168b7a'
      },
      {
        id: 'design',
        name: '设计规范',
        description: '界面规范、组件说明与品牌资产',
        files: 16,
        updated: '昨天',
        tone: '#3b82f6'
      }
    ]
  },
  {
    id: 'shared',
    label: '我的共享知识',
    icon: 'users',
    items: [
      {
        id: 'market',
        name: '增长策略研究',
        description: '面向团队共享的市场与增长洞察',
        files: 12,
        updated: '9 月 10 日',
        tone: '#d97706'
      },
      {
        id: 'onboarding',
        name: '新同事上手手册',
        description: '团队协作流程与常见问题',
        files: 9,
        updated: '9 月 6 日',
        tone: '#8b5cf6'
      }
    ]
  },
  {
    id: 'cloud',
    label: '云端知识库',
    icon: 'cloud',
    items: [
      {
        id: 'industry',
        name: '行业情报中心',
        description: '订阅报告、竞品动态与趋势资料',
        files: 42,
        updated: '今天 08:30',
        tone: '#0f9f8a'
      }
    ]
  }
]

// ── 当前知识库文件 ──
const KNOWLEDGE_FILES: KnowledgeFile[] = [
  {
    name: '2025 产品路线图 V3.pdf',
    type: 'PDF',
    size: '4.8 MB',
    updated: '今天 10:24',
    icon: 'file-text',
    tint: '#ef4444'
  },
  {
    name: '用户访谈纪要 · Q3.docx',
    type: 'DOCX',
    size: '832 KB',
    updated: '昨天 16:40',
    icon: 'file-type-2',
    tint: '#3b82f6'
  },
  {
    name: '需求优先级矩阵.xlsx',
    type: 'XLSX',
    size: '126 KB',
    updated: '9 月 9 日',
    icon: 'file-spreadsheet',
    tint: '#16a34a'
  },
  {
    name: '核心用户画像.md',
    type: 'MD',
    size: '24 KB',
    updated: '9 月 8 日',
    icon: 'file-text',
    tint: '#168b7a'
  },
  {
    name: '竞品功能对比.csv',
    type: 'CSV',
    size: '67 KB',
    updated: '9 月 5 日',
    icon: 'file-spreadsheet',
    tint: '#d97706'
  }
]

// ── 侧栏分组与选中知识库 ──
const expanded = ref<Record<string, boolean>>({ local: true, shared: true, cloud: true })
const knowledgeGroups = ref<KnowledgeGroup[]>(KNOWLEDGE_GROUPS)
const selectedLibrary = ref<KnowledgeFolder>(KNOWLEDGE_GROUPS[0].items[0])
const moreGroupId = ref<string | null>(null)
const openGroupMenu = ref<string | null>(null)

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

// ── 文件列表：排序、上传、标签页 ──
const files = ref<KnowledgeFile[]>(KNOWLEDGE_FILES)
const sortKey = ref<SortKey>('updated')
const ascending = ref(false)
const openTabs = ref<string[]>(['问答'])
const activeTab = ref('问答')

// ── 问答 ──
const question = ref('')
const answer = ref('')

// ── 左右分栏拖拽 ──
const filePanelPercent = ref(40)
const detailRef = ref<HTMLElement | null>(null)

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

const sortedFiles = computed(() =>
  [...files.value].sort((a, b) => {
    const left = a[sortKey.value]
    const right = b[sortKey.value]
    return `${left}`.localeCompare(`${right}`, 'zh-CN') * (ascending.value ? 1 : -1)
  })
)

const activeFile = computed(() => files.value.find((file) => file.name === activeTab.value))

/** 已建立索引的文件数（「只上传文件」的条目不计数） */
const indexedCount = computed(() => files.value.filter((file) => file.indexState !== 'none').length)

/** 文件区副标题：文件总数与索引情况 */
const fileSummary = computed(() => {
  const total = files.value.length
  if (!total) return '暂无文件'
  if (indexedCount.value === total) return `${total} 份文件已建立索引`
  return `${total} 份文件 · ${indexedCount.value} 份已建立索引`
})

/** 列表里的索引标记：只上传的文件与自定义索引的文件需要单独标出 */
const indexTagText = (file: KnowledgeFile): string => {
  if (file.indexState === 'none') return '未索引'
  if (file.indexState === 'custom') return '自定义索引'
  return ''
}

/** 「查看更多」页：当前分组下的知识库 + 两个归档卡片 */
const moreLibraries = computed<KnowledgeFolder[]>(() => {
  const group = moreGroup.value
  if (!group) return []
  const additional: KnowledgeFolder[] = [
    {
      id: `${group.id}-archive`,
      name: '历史项目归档',
      description: '已结项项目的文档、复盘与交付资料',
      files: 34,
      updated: '9 月 2 日',
      tone: '#64748b'
    },
    {
      id: `${group.id}-inbox`,
      name: '待整理资料箱',
      description: '新收集、等待分类归档的工作材料',
      files: 7,
      updated: '8 月 28 日',
      tone: '#e8793d'
    }
  ]
  return [...group.items, ...additional]
})

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

const addKnowledgeLibrary = (groupId: string): void => {
  const group = knowledgeGroups.value.find((item) => item.id === groupId)
  if (!group) return
  const library: KnowledgeFolder = {
    id: `${groupId}-${Date.now()}`,
    name: '未命名知识库',
    description: '等待补充说明的知识资料',
    files: 0,
    updated: '刚刚',
    tone: '#168b7a'
  }
  knowledgeGroups.value = knowledgeGroups.value.map((item) =>
    item.id === groupId ? { ...item, items: [...item.items, library] } : item
  )
  selectedLibrary.value = library
  toggleGroupOpen(groupId, true)
  notify(`已添加至「${group.label}」`)
}

const toggleGroupOpen = (groupId: string, open: boolean): void => {
  expanded.value = { ...expanded.value, [groupId]: open }
}

const selectLibrary = (library: KnowledgeFolder): void => {
  selectedLibrary.value = library
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

const toggleGroupMenu = (groupId: string): void => {
  openGroupMenu.value = openGroupMenu.value === groupId ? null : groupId
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

/** 编辑保存（名称 + 描述）：只改页面内列表，不落盘 */
const saveLibraryEdit = (name: string, description: string): void => {
  const target = editLibrary.value
  if (!target) return
  knowledgeGroups.value = renameLibrary(knowledgeGroups.value, target.id, { name, description })
  // 详情区读的是同一个对象，选中项需同步为更新后的值
  if (selectedLibrary.value.id === target.id) {
    selectedLibrary.value = { ...selectedLibrary.value, name, description, updated: '刚刚' }
  }
  notify(`已更新「${name}」`)
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

/** 删除确认：移除条目 → 切走选中 → 清理该库的按库覆盖配置 */
const confirmDeleteLibrary = async (): Promise<void> => {
  const target = deleteCandidate.value
  deleteCandidate.value = null
  if (!target) return
  const groupId = findGroupIdOf(knowledgeGroups.value, target.id)
  knowledgeGroups.value = removeLibrary(knowledgeGroups.value, target.id)
  if (selectedLibrary.value.id === target.id) {
    // 全部删空时返回 null，此时保留原引用（详情区只做属性读取，不会报错）
    const next = pickSelectionAfterRemoval(knowledgeGroups.value, groupId)
    if (next) selectedLibrary.value = next
  }
  // 列表本身无持久化，但按库配置有：顺手清掉，避免残留
  const cleaned = await knowledgeSettingsStore.saveOverrides(target.id, {})
  notify(cleaned ? `已删除「${target.name}」` : `已删除「${target.name}」，配置清理未完成`)
}

const onLibrarySettingsSaved = (name: string): void => {
  notify(`「${name}」设置已保存`)
}

/** 点击条目菜单以外的区域关闭菜单 */
const onDocumentMousedown = (event: MouseEvent): void => {
  if (!openLibMenu.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.kb-lib-row')) return
  openLibMenu.value = null
}

const onDocumentKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') openLibMenu.value = null
}

// ── 文件与标签页 ──
const openFile = (file: KnowledgeFile): void => {
  if (!openTabs.value.includes(file.name)) openTabs.value = [...openTabs.value, file.name]
  activeTab.value = file.name
}

const closeTab = (name: string): void => {
  openTabs.value = openTabs.value.filter((tab) => tab !== name)
  if (activeTab.value === name) activeTab.value = '问答'
}

const deleteFile = (file: KnowledgeFile): void => {
  files.value = files.value.filter((item) => item.name !== file.name)
  closeTab(file.name)
  notify('文件已删除')
}

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

/** 扩展名 → 表格里的三套文件图标 */
const pickFileIcon = (ext: string): FileIcon => {
  if (['csv', 'xls', 'xlsx'].includes(ext)) return 'file-spreadsheet'
  if (['doc', 'docx'].includes(ext)) return 'file-type-2'
  return 'file-text'
}

/** File → 列表条目（保留 File 对象，同时记下这次上传的索引方式） */
const toKnowledgeFile = (file: File, indexState: FileIndexState): KnowledgeFile => {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return {
    name: file.name,
    type: ext ? ext.toUpperCase() : '文件',
    size: formatSize(file.size),
    updated: '刚刚',
    icon: pickFileIcon(ext),
    tint: '#168b7a',
    indexState
  }
}

/** 上传文件夹：仍走系统目录选择，按「只上传文件」处理 */
const addUpload = (list: FileList | null): void => {
  if (!list?.length) return
  const newFiles = Array.from(list).map((file) => toKnowledgeFile(file, 'none'))
  files.value = [...newFiles, ...files.value]
  notify(`已上传 ${newFiles.length} 个文件（未建立索引）`)
}

const onUploadChange = (event: Event): void => {
  addUpload((event.target as HTMLInputElement).files)
}

/** 「上传文件」按钮：打开上传弹窗 */
const openUploadModal = (): void => {
  uploadOpen.value = true
}

/** 上传弹窗确定后的落地：按所选方式把文件加入列表（索引链路待主进程实现） */
const onUploadSubmit = (payload: KnowledgeUploadPayload): void => {
  const indexState: FileIndexState =
    payload.mode === 'none' ? 'none' : payload.mode === 'custom' ? 'custom' : 'default'
  const newFiles = payload.files.map((file) => toKnowledgeFile(file, indexState))
  files.value = [...newFiles, ...files.value]
  notify(uploadResultText(payload.mode, newFiles.length, payload.sourceLabel))
}

/** 选择文件夹：webkitdirectory 仅在点击前挂载，避免影响单文件上传框 */
const uploadFolder = (): void => {
  folderUploadRef.value?.setAttribute('webkitdirectory', '')
  folderUploadRef.value?.click()
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

// ── 问答提交 ──
const ask = (): void => {
  if (!question.value.trim()) return
  answer.value = `已基于「${selectedLibrary.value.name}」中的 ${files.value.length} 份资料开始检索。关于“${question.value.trim()}”，建议先查看《${files.value[0]?.name || '资料索引'}》中的相关章节；如需，我可以继续归纳要点或形成行动清单。`
  question.value = ''
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

onMounted(() => {
  updateTabScroll()
  window.addEventListener('resize', updateTabScroll)
  document.addEventListener('mousedown', onDocumentMousedown)
  document.addEventListener('keydown', onDocumentKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateTabScroll)
  document.removeEventListener('mousedown', onDocumentMousedown)
  document.removeEventListener('keydown', onDocumentKeydown)
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
          <button class="kb-more-create">
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
    <div v-else class="kb-workbench">
      <!-- ── 知识库分组侧栏 ── -->
      <aside class="kb-groups">
        <button class="kb-overview">
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
      <div ref="detailRef" class="kb-detail">
        <!-- 文件区 -->
        <section class="kb-files" :style="{ width: `${filePanelPercent}%` }">
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
              </div>
              <p class="kb-files-sub">{{ selectedLibrary.description }} · {{ fileSummary }}</p>
            </div>

            <div class="kb-files-actions">
              <input
                ref="folderUploadRef"
                type="file"
                multiple
                class="kb-file-input"
                @change="onUploadChange"
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
              <span></span>
            </div>

            <div v-for="file in sortedFiles" :key="file.name" class="kb-table-row">
              <button class="kb-file-btn" @click="openFile(file)">
                <span
                  class="kb-file-icon"
                  :style="{ color: file.tint, background: file.tint + '12' }"
                >
                  <svg
                    v-if="file.icon === 'file-text'"
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
                    v-else-if="file.icon === 'file-type-2'"
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
                <span class="kb-file-name">{{ file.name }}</span>
                <span
                  v-if="indexTagText(file)"
                  class="kb-file-tag"
                  :class="{ 'kb-file-tag--none': file.indexState === 'none' }"
                >
                  {{ indexTagText(file) }}
                </span>
              </button>
              <span class="kb-file-meta">{{ file.size }}</span>
              <span class="kb-file-meta">{{ file.updated }}</span>
              <button class="kb-file-del" title="删除文件" @click="deleteFile(file)">
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
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  <line x1="10" x2="10" y1="11" y2="17" />
                  <line x1="14" x2="14" y1="11" y2="17" />
                </svg>
              </button>
            </div>
          </div>
        </section>

        <!-- 分栏拖拽手柄 -->
        <div class="kb-resizer" title="拖动调整区域宽度" @mousedown="resizePanels">
          <span class="kb-resizer-bar"></span>
        </div>

        <!-- 问答 / 文件预览区 -->
        <aside class="kb-panel">
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
                <button class="kb-tab-name" @click="activeTab = tab">{{ tab }}</button>
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
          </div>

          <!-- 问答 -->
          <div v-if="activeTab === '问答'" class="kb-tab-content">
            <div class="kb-qa-banner">
              <p class="kb-qa-eyebrow">KNOWLEDGE Q&amp;A</p>
              <h2 class="kb-qa-title">向 {{ selectedLibrary.name }} 提问</h2>
              <p class="kb-qa-desc">答案会基于当前知识库中的文件生成。</p>
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

          <!-- 文件预览标签 -->
          <div v-else class="kb-file-tab">
            <div
              class="kb-file-tab-icon"
              :style="{
                color: activeFile?.tint,
                background: (activeFile?.tint || '#168b7a') + '14'
              }"
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
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                <path d="M10 9H8" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
              </svg>
            </div>
            <h2 class="kb-file-tab-title">{{ activeTab }}</h2>
            <p class="kb-file-tab-meta">
              {{ activeFile?.type }} · {{ activeFile?.size }} · 更新于 {{ activeFile?.updated }}
            </p>
            <div class="kb-file-tab-preview">
              文件预览区域<br /><br />已在右侧以独立标签打开。可切换至“问答”标签，针对当前知识库继续提问。
            </div>
          </div>
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
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid #e1ebe7;
  background: #ffffff;
}
.kb-table-head {
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

/* ── 文件预览标签 ── */
.kb-file-tab {
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 20px;
}
.kb-file-tab-icon {
  display: flex;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}
.kb-file-tab-title {
  margin: 16px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #26383d;
}
.kb-file-tab-meta {
  margin: 8px 0 0;
  font-size: 12px;
  color: #869398;
}
.kb-file-tab-preview {
  margin-top: 24px;
  border-radius: 12px;
  border: 1px solid #e5ece9;
  background: #fafcfb;
  padding: 16px;
  font-size: 12px;
  line-height: 24px;
  color: #65767a;
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
</style>
