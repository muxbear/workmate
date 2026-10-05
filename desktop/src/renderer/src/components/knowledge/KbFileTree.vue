<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ComponentPublicInstance, Ref } from 'vue'
import {
  collectFileNodes,
  flattenVisible,
  sortTree,
  type KnowledgeNode,
  type KnowledgeSortKey
} from './knowledgeTree'
import { DOC_BADGE, resolveDocBadgeKind } from './indexStages'
import type { KnowledgeFolder } from './knowledgeList'
import type { useCloudDocs } from '@renderer/composables/useCloudDocs'
import type { useKbDocOps } from '@renderer/composables/useKbDocOps'
import type { useKbFileOps } from '@renderer/composables/useKbFileOps'
import type { useKbFiles } from '@renderer/composables/useKbFiles'
import type { useKbUploads } from '@renderer/composables/useKbUploads'

/**
 * 文件区（R6：自 KnowledgePage 模板外提）。
 *
 * 库头部（徽标/标题/操作菜单/上传动作）+ 文件表（排序表头、文件夹与文件行、
 * 状态列、行内三点菜单、云端分页脚）。接口范式：注入组合件 API 对象
 * （useCloudDocs / useKbFiles / useKbUploads / useKbFileOps / useKbDocOps）
 * 与页面持有的视图态/动作（行菜单与库菜单开关、标签页与右栏联动留在页面）。
 *
 * 排序态（sortKey/ascending）与展示派生（fileSummary 等）此前只服务本区模板，
 * 随模板归位为实例内状态（与 ThinkingBlock / MessageActions 同法）。
 */
const props = defineProps<{
  /** 当前渲染的树（本地/云端由页面切换） */
  activeTree: KnowledgeNode[]
  /** 展示用知识库（标题/描述/色调；云库与本地库共用一套模板） */
  displayLibrary: KnowledgeFolder
  /** 当前选中知识库（「创建共享」等按库动作的上下文） */
  selectedLibrary: KnowledgeFolder
  /** 云文档组合件（useCloudDocs 返回值） */
  cloud: ReturnType<typeof useCloudDocs>
  /** 文件树组合件（useKbFiles：展开态/折叠切换） */
  files: ReturnType<typeof useKbFiles>
  /** 上传组合件（useKbUploads：弹窗/文件夹选择） */
  uploads: ReturnType<typeof useKbUploads>
  /** 文件行操作组合件（useKbFileOps：详情/重命名/打开目录） */
  fileOps: ReturnType<typeof useKbFileOps>
  /** 文档与库头部操作组合件（useKbDocOps：索引/共享/删除/库菜单） */
  docOps: ReturnType<typeof useKbDocOps>
  /** 文件区宽度样式（useKbLayout 的拖拽结果） */
  filePanelStyle: Record<string, string>
  /** 页面持有的元素 ref（方盒传递：直接传 Ref 会被模板自动解包成值） */
  elementRefs: { folderUploadRef: Ref<HTMLInputElement | null> }
  /** 文件行菜单当前 key（页面持有：外部点击关闭靠页面全局监听） */
  fileMenuKey: string | null
  /** 库头部菜单开关（同上） */
  libraryMenuOpen: boolean
  /** 页面动作（标签页/右栏联动留在页面） */
  openFile: (node: KnowledgeNode) => void
  openPipeline: (node: KnowledgeNode) => void
  canOpenPipeline: (node: KnowledgeNode) => boolean
  openFileMenu: (key: string) => void
  leaveFileMenu: (key: string) => void
  toggleLibraryMenu: () => void
}>()

const {
  isCloudView,
  cloudDocs,
  cloudDocsTotal,
  cloudDocsLoading,
  cloudDocsMessage,
  refreshCloudDocs,
  loadCloudDocs,
  downloadCloudDoc
} = props.cloud
const { isFolderExpanded, toggleFolder } = props.files
const { onFolderChange, openUploadModal, uploadFolder } = props.uploads
const { openFileDetail, openFileRename, openFileDir } = props.fileOps
const {
  rebuildIndex,
  retryIndex,
  reextractGraph,
  cancelIndexing,
  rebuildCommunities,
  openSearchDebug,
  openGraphView,
  openShare,
  askDeleteFile,
  openLibraryRename,
  openLibraryDir,
  openLibrarySettingsFromHeader,
  deleteLibraryFromHeader
} = props.docOps

/** input 挂载/卸载时写回页面持有的元素 ref（useKbUploads 读取同一引用） */
const setFolderUpload = (el: Element | ComponentPublicInstance | null): void => {
  props.elementRefs.folderUploadRef.value = el instanceof HTMLInputElement ? el : null
}

// ── 排序（只服务本区表格，实例内状态）──
const sortKey = ref<KnowledgeSortKey>('updated')
const ascending = ref(false)

/** 排序后的文件树（文件夹恒排在文件前） */
const sortedTree = computed(() => sortTree(props.activeTree, sortKey.value, ascending.value))

/** 展开可见行：文件夹折叠时跳过其子节点 */
const rows = computed(() => flattenVisible(sortedTree.value, isFolderExpanded))

/** 全部文件节点（不含文件夹） */
const allFiles = computed(() => collectFileNodes(props.activeTree))

/** 已建立索引的文件数（只上传文件与索引失败的条目不计数） */
const indexedCount = computed(
  () => allFiles.value.filter((node) => node.file?.status === 'indexed').length
)
/** 正在索引（排队 + 运行中）的文件数 */
const indexingCount = computed(
  () =>
    allFiles.value.filter(
      (node) => node.file?.status === 'queued' || node.file?.status === 'indexing'
    ).length
)
/** 索引失败的文件数 */
const failedCount = computed(
  () => allFiles.value.filter((node) => node.file?.status === 'failed').length
)
/** 图谱抽取失败的文件数（文档本身已可检索，但实体/关系为空；错误在 graph_error 里） */
const graphFailedCount = computed(
  () => allFiles.value.filter((node) => node.file?.graphError).length
)

/** 文件区副标题：文件总数与索引情况（真实索引状态，不再有「开发中」占位） */
const fileSummary = computed(() => {
  const total = allFiles.value.length
  if (!total) return '暂无文件'
  if (isCloudView.value) return `${total} 份文件 · 云端只读`
  const parts = [`${total} 份文件`]
  parts.push(`${indexedCount.value} 份已建立索引`)
  if (indexingCount.value) parts.push(`${indexingCount.value} 索引中`)
  if (failedCount.value) parts.push(`${failedCount.value} 失败`)
  if (graphFailedCount.value) parts.push(`${graphFailedCount.value} 图谱失败`)
  return parts.join(' · ')
})

/** 状态列的徽标：文案对齐 web（排队/解析中/切片中/向量化/BM25 倒排/实体抽取/已索引/失败） */
interface StatusCellBadge {
  label: string
  cls: string
}
const statusBadgeOf = (node: KnowledgeNode): StatusCellBadge | null => {
  const file = node.file
  if (!file) return null
  const kind = resolveDocBadgeKind({
    status: file.status,
    stage: file.stage,
    progress: file.progress
  })
  if (kind) return { label: DOC_BADGE[kind].label, cls: `kb-doc-badge ${DOC_BADGE[kind].cls}` }
  // 解析不到状态（只上传 / 自定义索引）时落回桌面自己的标签；云行（无 status）也走这里
  if (file.indexState === 'none') return { label: '未索引', cls: 'kb-file-tag kb-file-tag--none' }
  if (file.indexState === 'custom') return { label: '自定义索引', cls: 'kb-file-tag' }
  return null
}

/** 徽标悬停提示：失败原因 / 正在索引的百分比（列表行放不下全文） */
const statusCellTitle = (node: KnowledgeNode): string => {
  const file = node.file
  if (!file) return ''
  if (file.status === 'failed') return `索引失败：${file.errorMessage || '未知原因'}`
  if (file.status === 'indexing') return `正在索引（${Math.round(file.progress ?? 0)}%）`
  return ''
}

/** 图谱失败警示图标的悬停提示（web 同款文案） */
const graphWarnTitle = (node: KnowledgeNode): string =>
  `图谱未生成：${node.file?.graphError ?? '未知原因'}`

/** 分片列：无分片显示 —（web 同款） */
const chunksText = (node: KnowledgeNode): string => {
  const count = node.file?.chunksCount ?? 0
  return count > 0 ? String(count) : '—'
}

/** 实体/关系列：0 与缺失都显示 —（web 同款） */
const erText = (node: KnowledgeNode): string =>
  `${node.file?.entitiesCount || '—'} / ${node.file?.relationsCount || '—'}`

const changeSort = (key: KnowledgeSortKey): void => {
  if (sortKey.value === key) {
    ascending.value = !ascending.value
  } else {
    sortKey.value = key
    ascending.value = true
  }
}
</script>

<template>
  <section class="kb-files" :style="filePanelStyle">
    <div class="kb-files-header">
      <div>
        <div class="kb-files-title-row">
          <span
            class="kb-lib-badge"
            :style="{
              color: displayLibrary.tone,
              background: displayLibrary.tone + '14'
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
          <h1 class="kb-files-title">{{ displayLibrary.name }}</h1>
          <!-- 知识库操作：本地 = 重命名/创建共享/索引设置/删除；云端只读 = 刷新 -->
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
              <!-- 云库只读：重命名/共享/索引/删除都在 Web 版做，这里只有刷新 -->
              <button v-if="isCloudView" class="kb-lib-menu-item" @click="refreshCloudDocs">
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
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                刷新
              </button>
              <button
                v-if="!isCloudView"
                class="kb-lib-menu-item"
                @click="openLibraryRename"
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
                    d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                  />
                  <path d="m15 5 4 4" />
                </svg>
                重命名
              </button>
              <button v-if="!isCloudView" class="kb-lib-menu-item" @click="openLibraryDir">
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
                v-if="!isCloudView"
                class="kb-lib-menu-item"
                @click="openGraphView"
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
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                查看图谱
              </button>
              <button
                v-if="!isCloudView"
                class="kb-lib-menu-item"
                @click="rebuildCommunities"
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
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="5" cy="6" r="2" />
                  <circle cx="19" cy="6" r="2" />
                  <circle cx="5" cy="18" r="2" />
                  <circle cx="19" cy="18" r="2" />
                  <path d="M6.5 7.5 10 10.5" />
                  <path d="M17.5 7.5 14 10.5" />
                  <path d="M6.5 16.5 10 13.5" />
                  <path d="M17.5 16.5 14 13.5" />
                </svg>
                重建社区摘要
              </button>
              <button
                v-if="!isCloudView"
                class="kb-lib-menu-item"
                @click="openSearchDebug"
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
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                检索调试
              </button>
              <button
                v-if="!isCloudView"
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
              <button
                v-if="!isCloudView"
                class="kb-lib-menu-item"
                @click="openLibrarySettingsFromHeader"
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
                  <circle cx="12" cy="12" r="3" />
                  <path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                  />
                </svg>
                索引设置
              </button>
              <button
                v-if="!isCloudView"
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
        <p class="kb-files-sub">{{ displayLibrary.description }} · {{ fileSummary }}</p>
      </div>

      <div class="kb-files-actions">
        <!-- 云库只读：没有上传，只提供刷新（与本地"上传"同一位置） -->
        <button v-if="isCloudView" class="kb-btn-ghost" @click="refreshCloudDocs">
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
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          {{ cloudDocsLoading ? '同步中…' : '刷新' }}
        </button>
        <template v-if="!isCloudView">
          <!-- 上传文件夹：webkitdirectory 让系统选择器只能选目录 -->
          <input
            :ref="setFolderUpload"
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
        </template>
      </div>
    </div>

    <div class="kb-table">
      <!-- 列与 web 版「文档」页签一致（文档/大小/分片/实体关系/状态），操作列是桌面自己的 -->
      <div class="kb-table-head">
        <button class="kb-sort-btn" @click="changeSort('name')">
          文档
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
        <span class="kb-col-chunks">分片</span>
        <span class="kb-col-er">实体/关系</span>
        <span class="kb-col-status">状态</span>
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
        </button>
        <span class="kb-file-meta">{{ row.node.file?.size ?? '—' }}</span>
        <span class="kb-file-meta kb-col-chunks">{{ chunksText(row.node) }}</span>
        <span class="kb-file-meta kb-col-er">
          {{ row.node.kind === 'file' ? erText(row.node) : '—' }}
        </span>

        <!-- 状态列：徽标 + 图谱失败警示 + 行内细进度条；点格打开索引进度标签 -->
        <div
          class="kb-col-status"
          :class="{
            'kb-status-cell': row.node.kind === 'file',
            'kb-status-cell--clickable': canOpenPipeline(row.node)
          }"
          :role="canOpenPipeline(row.node) ? 'button' : undefined"
          :tabindex="canOpenPipeline(row.node) ? 0 : undefined"
          :aria-label="
            canOpenPipeline(row.node) ? `查看《${row.node.name}》的索引情况` : undefined
          "
          @click="openPipeline(row.node)"
          @keydown.enter="openPipeline(row.node)"
        >
          <template v-if="row.node.kind === 'file'">
            <div class="kb-status-line">
              <span
                v-if="statusBadgeOf(row.node)"
                :class="statusBadgeOf(row.node)?.cls"
                :title="statusCellTitle(row.node)"
              >
                {{ statusBadgeOf(row.node)?.label }}
              </span>
              <span
                v-if="row.node.file?.graphError"
                class="kb-graph-warn"
                :title="graphWarnTitle(row.node)"
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
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" x2="12" y1="8" y2="12" />
                  <line x1="12" x2="12.01" y1="16" y2="16" />
                </svg>
              </span>
            </div>
            <div v-if="row.node.file?.status === 'indexing'" class="kb-inline-progress">
              <span
                class="kb-inline-progress-bar"
                :style="{ width: `${Math.round(row.node.file?.progress ?? 0)}%` }"
              ></span>
            </div>
          </template>
        </div>

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
            <!-- 云文档只读：只有预览与下载（重命名/重建索引/共享/删除都在 Web 版） -->
            <template v-if="isCloudView">
              <button class="kb-lib-menu-item" @click="openFile(row.node)">预览</button>
              <button class="kb-lib-menu-item" @click="downloadCloudDoc(row.node)">
                下载
              </button>
            </template>
            <button
              v-if="!isCloudView"
              class="kb-lib-menu-item"
              @click="openFileDetail(row.node)"
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
                  d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
                />
                <circle cx="12" cy="12" r="3" />
              </svg>
              查看详情
            </button>
            <button
              v-if="!isCloudView"
              class="kb-lib-menu-item"
              @click="openFileRename(row.node)"
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
                  d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                />
                <path d="m15 5 4 4" />
              </svg>
              重新命名
            </button>
            <button
              v-if="!isCloudView"
              class="kb-lib-menu-item"
              @click="openFileDir(row.node)"
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
                  d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
                />
              </svg>
              打开文件夹
            </button>
            <button
              v-if="!isCloudView && row.node.kind === 'file'"
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
              v-if="!isCloudView && row.node.kind === 'file' && row.node.file?.status === 'failed'"
              class="kb-lib-menu-item"
              @click="retryIndex(row.node)"
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
                <path d="M20 6 9 17l-5-5" />
              </svg>
              重试索引
            </button>
            <button
              v-if="
                !isCloudView &&
                row.node.kind === 'file' &&
                (row.node.file?.status === 'queued' || row.node.file?.status === 'indexing')
              "
              class="kb-lib-menu-item"
              @click="cancelIndexing(row.node)"
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
                <circle cx="12" cy="12" r="10" />
                <path d="m15 9-6 6" />
                <path d="m9 9 6 6" />
              </svg>
              取消索引
            </button>
            <button
              v-if="!isCloudView && row.node.kind === 'file' && row.node.file?.status === 'indexed'"
              class="kb-lib-menu-item"
              @click="reextractGraph(row.node)"
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
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M20 4 8.12 15.88" />
                <path d="M14.8 14.8 20 20" />
              </svg>
              重抽图谱
            </button>
            <button
              v-if="!isCloudView"
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
              v-if="!isCloudView"
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
      <!-- 云端：分页与状态（本地库没有分页概念，这里只在云端出现） -->
      <div v-if="isCloudView" class="kb-cloud-foot">
        <p v-if="cloudDocsMessage" class="kb-cloud-note">{{ cloudDocsMessage }}</p>
        <p v-else-if="cloudDocsLoading" class="kb-cloud-note">正在同步云端文档…</p>
        <button
          v-if="!cloudDocsLoading && cloudDocs.length < cloudDocsTotal"
          class="kb-btn-ghost"
          @click="loadCloudDocs(true)"
        >
          加载更多（已显示 {{ cloudDocs.length }}/{{ cloudDocsTotal }}）
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════════════════
   文件区（R6：自 KnowledgePage 外提，规则逐字迁移）
   ═══════════════════════════════════════════════════════════════════════════ */
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
/* 云端文档区页脚：状态提示与「加载更多」（本地库没有分页，只在云端出现） */
.kb-cloud-foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0 4px;
}

.kb-cloud-note {
  margin: 0;
  font-size: 12px;
  color: #8a969a;
}

.kb-table-head {
  border-radius: 16px 16px 0 0;
  display: grid;
  /* 文档 / 大小 / 分片 / 实体关系 / 状态 / 操作（前五列与 web 文档页签一致） */
  grid-template-columns: minmax(0, 1fr) 76px 56px 104px 168px 36px;
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
  grid-template-columns: minmax(0, 1fr) 76px 56px 104px 168px 36px;
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
/* ── 状态列：web 口径徽标 + 图谱失败警示图标 + 行内细进度条（点格打开索引进度标签）── */
.kb-status-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.kb-status-cell--clickable {
  cursor: pointer;
}
.kb-status-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.kb-doc-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid transparent;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}
/* 配色抄 web KbDocStatusBadge.vue（同色系、桌面调色板） */
.kb-doc-badge--queued {
  background: rgba(100, 116, 139, 0.15);
  border-color: rgba(100, 116, 139, 0.3);
  color: #64748b;
}
.kb-doc-badge--parsing {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.3);
  color: #3b82f6;
}
.kb-doc-badge--chunking {
  background: rgba(6, 182, 212, 0.15);
  border-color: rgba(6, 182, 212, 0.3);
  color: #0891b2;
}
.kb-doc-badge--embedding {
  background: rgba(139, 92, 246, 0.15);
  border-color: rgba(139, 92, 246, 0.3);
  color: #8b5cf6;
}
.kb-doc-badge--bm25 {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.3);
  color: #d97706;
}
.kb-doc-badge--extracting {
  background: rgba(236, 72, 153, 0.15);
  border-color: rgba(236, 72, 153, 0.3);
  color: #db2777;
}
.kb-doc-badge--indexed {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.3);
  color: #147967;
}
.kb-doc-badge--failed {
  background: rgba(244, 63, 94, 0.15);
  border-color: rgba(244, 63, 94, 0.3);
  color: #e05561;
}
.kb-inline-progress {
  height: 3px;
  border-radius: 999px;
  background: #e8efec;
  overflow: hidden;
}
.kb-inline-progress-bar {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #168b7a;
  transition: width 0.2s ease;
}
.kb-graph-warn {
  display: inline-flex;
  flex-shrink: 0;
  color: #d97706;
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

/* 菜单项（文件行菜单 / 库头部菜单共用）。22 刀把页面侧唯一实现随侧栏搬去
   KbSidebarGroups 的 scoped 样式，页面剩余使用点一度失样式；本刀随菜单归位。 */
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

/* ── 窄窗口兜底（原页面公共媒体查询中的文件区部分） ── */
@media (max-width: 1699px) {
  .kb-table-head,
  .kb-table-row {
    grid-template-columns: minmax(120px, 1fr) 56px 44px 80px 132px 30px;
    column-gap: 10px;
  }
  /* 文件区至少容纳「文档 + 大小 + 分片 + 实体关系 + 状态 + 操作」六列：
     552（列+间距+行内边距）+ 56（.kb-files 左右内边距），避免操作列溢出卡片 */
  .kb-files {
    min-width: 610px;
  }
}
@media (max-width: 1199px) {
  .kb-table-head,
  .kb-table-row {
    grid-template-columns: minmax(72px, 1fr) 44px 40px 120px 28px;
    column-gap: 8px;
  }
  /* 极窄下隐藏最不常用的「实体/关系」列（沿用「查看更多」表在窄窗口收列的做法） */
  .kb-col-er {
    display: none;
  }
  /* 376（五列+间距+行内边距）+ 56（.kb-files 左右内边距），刚好落在 440 内 */
  .kb-files {
    min-width: 440px;
  }
}
</style>
