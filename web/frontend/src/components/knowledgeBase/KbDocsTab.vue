<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Search, Upload, Trash2, RefreshCw, FolderOpen, Folder, Ban, CircleAlert,
  FileType2, FileCode2, FileText, FileSpreadsheet, FileImage, Globe,
  Eye, Scissors, Download, ClipboardPaste, ScanText, ChevronRight, ArrowUp,
} from 'lucide-vue-next'
import type { KB, KBDoc, DocType, IndexConfig } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import { downloadDocument, readApiError } from '@/services/knowledgeBaseApi'
import { crumbsOf, parentFolder } from '@/utils/kbPath'
import KbDocStatusBadge from './KbDocStatusBadge.vue'
import KbUploadDialog from './KbUploadDialog.vue'
import KbPasteTextDialog from './KbPasteTextDialog.vue'
import KbUrlImportDialog from './KbUrlImportDialog.vue'
import KbIndexingPipeline from './KbIndexingPipeline.vue'
import KbSkeleton from './KbSkeleton.vue'
import KbFragmentEditor from './KbFragmentEditor.vue'

const props = defineProps<{
  kb: KB
  /** 只读态（公共库 / 他人分享）：隐藏上传、删除、重试与切片编辑 */
  readonly?: boolean
}>()

/**
 * 点开一篇文档 → 交给宿主在右侧问答区开一个预览标签。
 *
 * 预览刻意**不在这里就地展开**：文档正文是"看一眼再回到列表"的高频动作，占满整个
 * 内容区会让人必须再点一次返回；放进问答区的标签行则可以和其它文档并排看。
 */
const emit = defineEmits<{
  (e: 'preview-doc', doc: KBDoc): void
}>()

// 注意：computed 必须在 props 之后定义（下面 selectedDoc 会用到 props.kb）

const store = useKnowledgeBaseStore()
const { t } = useI18n()

const uploadVisible = ref(false)
// 只存 id，面板用 computed 从最新列表里取——列表在 SSE/轮询后会被整体替换，
// 若这里存对象引用，面板会永远显示打开那一刻的快照（行徽标却在更新，自相矛盾）
const selectedDocId = ref<string | null>(null)

const selectedDoc = computed(
  () => props.kb.documents.find((d) => d.id === selectedDocId.value) ?? null,
)
const editDoc = ref<KBDoc | null>(null)

const docTypeIcons: Record<DocType, typeof FileText> = {
  pdf: FileType2, md: FileCode2, docx: FileText, csv: FileSpreadsheet, image: FileImage, html: Globe,
}

/**
 * 列表内容直接用服务端返回的（迭代 6 T6.6）。
 *
 * 此前这里是"拉 100 条再在前端按名字过滤"，而列表现在已经分页——只过滤当前页会让
 * **搜不到变成假象**：匹配的文档可能就在下一页。所以搜索也走服务端。
 */
const filteredDocs = computed(() => props.kb.documents)

// 输入防抖：每敲一个字就发一次请求既费又能让结果乱序
const searchInput = ref(props.kb.id ? store.docQuery.search : '')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    void store.loadDocs(props.kb.id, { search: value.trim(), page: 1 })
  }, 300)
})
// 换库时把输入框同步回该库的搜索词（新库一律是空）
watch(
  () => props.kb.id,
  () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchInput.value = store.docQuery.search
  },
)
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/** 有搜索词时"没有结果"是另一回事——要说清是"没匹配"而不是"这个库是空的" */
const searching = computed(() => store.docQuery.search.trim().length > 0)

// ─── 目录浏览 ─────────────────────────────────────────────────────────────

/**
 * 当前目录一律从 **store** 派生（不是组件局部 ref）。
 *
 * 文档列表会被 SSE / 30s 兜底刷新整体替换，那些刷新走的是无参 `loadDocs`、沿用
 * store 里的 folder；组件自己再存一份就会与它失步——表现为"刷新一下跳回根目录"。
 */
const currentFolder = computed(() => store.docQuery.folder)
const crumbItems = computed(() => crumbsOf(currentFolder.value))
/** 上一级（根目录时为 null，按钮不显示） */
const upFolder = computed(() => (currentFolder.value ? parentFolder(currentFolder.value) : null))

/** 当前目录下的直属子目录（搜索态不显示：那时列的是全库匹配结果） */
const folderRows = computed(() =>
  searching.value ? [] : store.folders.filter((f) => f.parent === currentFolder.value),
)

/** 目录行的递归篇数：目录自身 + 各级子目录的直属数（Windows 也是这么数的） */
function folderTotal(path: string): number {
  const prefix = `${path}/`
  return store.folders.reduce(
    (sum, f) => (f.path === path || f.path.startsWith(prefix) ? sum + f.docCount : sum),
    0,
  )
}

async function goToFolder(path: string) {
  if (path === currentFolder.value) return
  // 进目录必须**同时**清掉搜索词：否则列表已是目录内容、输入框里还挂着旧词；
  // 而防抖定时器也要一并取消——300ms 后它会把旧词再打回来，看起来像"点了没反应"
  if (searchTimer) clearTimeout(searchTimer)
  searchInput.value = ''
  clearSelection()
  store.selectedDoc = null
  selectedDocId.value = null
  await store.loadDocs(props.kb.id, { folder: path, search: '', page: 1 })
}

/** 文档所在位置的展示文案（搜索结果里用，根目录显示"根目录"） */
function locationOf(doc: KBDoc): string {
  return doc.folder || t('knowledge.docs.rootFolder')
}

/** 上传对话框关闭后对齐列表与目录树（整目录上传的新目录要立刻出现在路径条下） */
function refreshAfterUpload() {
  void store.loadDocs(props.kb.id)
  void store.loadFolders(props.kb.id)
}

const pasteVisible = ref(false)
const urlVisible = ref(false)
const urlError = ref<string | null>(null)
const batchRunning = ref(false)

/** 被跳过文件的提示文案：必须说清"重复于哪一篇"，否则用户会以为文件丢了 */
function skipSummary(skipped: { name: string; existingDocName?: string | null }[]): string {
  const first = skipped[0]
  const detail = first.existingDocName ? `（与《${first.existingDocName}》内容相同）` : ''
  return skipped.length === 1
    ? `已跳过 ${first.name}${detail}`
    : `已跳过 ${skipped.length} 个重复文件，如 ${first.name}${detail}`
}

async function handlePaste(name: string, content: string, config?: IndexConfig) {
  try {
    // 落在当前目录：在 a/b 里粘贴却掉进根目录的话，列表纹丝不动，像功能坏了
    const result = await store.createTextDoc(props.kb.id, {
      name, content, config, folder: currentFolder.value,
    })
    pasteVisible.value = false
    if (result.skipped.length) {
      ElMessage.warning(skipSummary(result.skipped))
    } else {
      ElMessage.success('已创建文档，正在建立索引')
    }
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  }
}

async function handleUrlImport(url: string, config?: IndexConfig) {
  urlError.value = null
  try {
    const result = await store.importUrlDoc(props.kb.id, {
      url, config, folder: currentFolder.value,
    })
    urlVisible.value = false
    if (result.skipped.length) {
      ElMessage.warning(skipSummary(result.skipped))
    } else {
      ElMessage.success('已导入，正在建立索引')
    }
  } catch (err: unknown) {
    // 就地显示原因（含"未配置白名单"的配置指引），地址保留便于修正后重试
    urlError.value = readApiError(err)
  }
}

async function handleDelete(docId: string) {
  const doc = props.kb.documents.find((d) => d.id === docId)
  try {
    // 文档是硬删除（向量与磁盘一并清掉、不可恢复），此前单条删除没有二次确认
    await ElMessageBox.confirm(
      `删除《${doc?.name ?? docId}》？该文档的切片与向量会一并清除，不可恢复。`,
      '删除文档',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return   // 用户取消
  }
  try {
    await store.deleteDoc(props.kb.id, docId)
    ElMessage.success('已删除')
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  }
}

// ─── 选择集与批量操作 ─────────────────────────────────────────────────────

// 只存 id：SSE 与 5s 轮询会把 documents 整体替换，存对象引用会拿到过期快照
const selected = ref<Set<string>>(new Set())

/**
 * 与当前列表求交后的选择集。
 *
 * 列表被刷新后，选择集里可能残留已经消失的 id——直接拿它去批量请求会得到一串
 * "文档不存在"。计数与按钮显隐也都用这个（而不是 selected 本身）。
 */
const effectiveSelection = computed(() => {
  const alive = new Set(props.kb.documents.map((d) => d.id))
  return [...selected.value].filter((id) => alive.has(id))
})

const allSelected = computed(
  () => filteredDocs.value.length > 0
    && filteredDocs.value.every((d) => selected.value.has(d.id)),
)

function toggleSelect(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleSelectAll() {
  const next = new Set(selected.value)
  if (allSelected.value) {
    filteredDocs.value.forEach((d) => next.delete(d.id))
  } else {
    filteredDocs.value.forEach((d) => next.add(d.id))
  }
  selected.value = next
}

function clearSelection() {
  selected.value = new Set()
}

async function handleBatchDelete() {
  const ids = effectiveSelection.value
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(
      `删除所选的 ${ids.length} 篇文档？切片与向量会一并清除，不可恢复。`,
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await runBatch('delete', ids)
}

async function handleBatchRetry() {
  const ids = effectiveSelection.value
  if (!ids.length) return
  // 已索引完成的文档重试会被后端拒绝（400）——先在前端过滤并说清，免得用户
  // 收到一串"已索引完成"的失败项
  const retryable = props.kb.documents
    .filter((d) => ids.includes(d.id) && d.status !== 'indexed')
    .map((d) => d.id)
  const skippedDone = ids.length - retryable.length
  if (!retryable.length) {
    ElMessage.info('所选文档都已索引完成，无需重试')
    return
  }
  if (skippedDone) {
    ElMessage.info(`已跳过 ${skippedDone} 篇索引完成的文档`)
  }
  await runBatch('retry', retryable)
}

async function runBatch(action: 'delete' | 'retry', ids: string[]) {
  try {
    batchRunning.value = true
    const result = await store.batchDocs(props.kb.id, action, ids)
    clearSelection()
    const label = action === 'delete' ? '删除' : '重试'
    if (result.failed === 0) {
      ElMessage.success(`已${label} ${result.succeeded} 篇`)
    } else {
      // 部分成功是正常结果：把失败原因说清楚，而不是笼统报错
      const reason = result.items.find((i) => !i.ok)?.message
      ElMessage.warning(
        `${label}完成：成功 ${result.succeeded} 篇，失败 ${result.failed} 篇${reason ? `（${reason}）` : ''}`,
      )
    }
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  } finally {
    batchRunning.value = false
  }
}

async function handleDownload(doc: KBDoc) {
  try {
    await downloadDocument(props.kb.id, doc.id, doc.name)
  } catch (err: unknown) {
    ElMessage.error(readApiError(err))
  }
}

async function handleRetry(docId: string) {
  try {
    await store.retryDoc(props.kb.id, docId)
  } catch (err: unknown) {
    const msg = readApiError(err)
    ElMessage.error(msg)
  }
}

/** 正在索引的文档（可取消）：排除终态 */
// 排队中与各执行阶段都可取消——批量上传超过并发上限（默认 3）时，
// 队列里的文档同样需要能停下来
const TERMINAL_STATUSES = ['indexed', 'failed', 'canceled']

function isActive(status: KBDoc['status']) {
  return !TERMINAL_STATUSES.includes(status)
}

function canRetry(status: KBDoc['status']) {
  // 后端只拒绝"已索引完成"的重试，其余状态（失败/已取消/卡在中间态）都可重跑
  return status !== 'indexed'
}

async function handleCancel(docId: string) {
  try {
    await store.cancelDoc(props.kb.id, docId)
    ElMessage.success('已取消索引')
  } catch (err: unknown) {
    const msg = readApiError(err)
    ElMessage.error(msg)
  }
}

function toggleDocPanel(doc: KBDoc) {
  if (selectedDocId.value === doc.id) {
    selectedDocId.value = null
  } else {
    selectedDocId.value = doc.id
  }
}

function handleViewDetail(doc: KBDoc) {
  emit('preview-doc', doc)
}

function handleEditFragment(doc: KBDoc) {
  editDoc.value = doc
}
</script>

<template>
  <div class="docs-tab">
    <!-- 编辑分片 (full-page inline view) -->
    <KbFragmentEditor
      v-if="editDoc"
      :doc="editDoc"
      :kb-id="kb.id"
      @back="editDoc = null"
    />

    <!-- 文档列表 -->
    <template v-else>
      <div class="docs-layout" :class="{ 'has-panel': selectedDoc }">
        <div class="docs-table-area">
          <!-- 工具栏 -->
          <div class="docs-toolbar">
            <div class="search-wrap">
              <Search :size="16" class="search-icon" />
              <input
                v-model="searchInput"
                type="text"
                placeholder="检索文档…"
                class="search-input"
              />
            </div>
            <button v-if="!readonly" class="btn-upload" @click="uploadVisible = true">
              <Upload :size="16" class="btn-icon" />{{ t('knowledge.docs.upload') }}
            </button>
            <button
              v-if="!readonly"
              class="btn-upload btn-secondary"
              @click="pasteVisible = true"
            >
              <ClipboardPaste :size="16" class="btn-icon" />{{ t('knowledge.docs.pasteText') }}
            </button>
            <button
              v-if="!readonly"
              class="btn-upload btn-secondary"
              @click="urlError = null; urlVisible = true"
            >
              <Globe :size="16" class="btn-icon" />{{ t('knowledge.docs.importUrl') }}
            </button>
            <!-- 批量入口：仅在有选中项时出现（selected 与当前列表求交后的计数） -->
            <button
              v-if="!readonly && effectiveSelection.length > 0"
              class="btn-upload btn-secondary"
              :disabled="batchRunning"
              @click="handleBatchRetry"
            >
              <RefreshCw :size="16" class="btn-icon" />重试所选 ({{ effectiveSelection.length }})
            </button>
            <button
              v-if="!readonly && effectiveSelection.length > 0"
              class="btn-upload btn-danger"
              :disabled="batchRunning"
              @click="handleBatchDelete"
            >
              <Trash2 :size="16" class="btn-icon" />删除所选 ({{ effectiveSelection.length }})
            </button>
          </div>

          <!-- 路径条：目录浏览的"当前位置"与回退入口 -->
          <div class="path-bar">
            <button
              v-if="upFolder !== null"
              class="path-up"
              :title="t('knowledge.docs.goUp')"
              @click="goToFolder(upFolder)"
            >
              <ArrowUp :size="14" />{{ t('knowledge.docs.goUp') }}
            </button>
            <nav class="crumbs" :aria-label="t('knowledge.docs.pathLabel')">
              <button
                class="crumb"
                :class="{ 'is-current': !currentFolder }"
                @click="goToFolder('')"
              >
                <FolderOpen :size="13" />{{ t('knowledge.docs.rootFolder') }}
              </button>
              <template v-for="crumb in crumbItems" :key="crumb.path">
                <ChevronRight :size="12" class="crumb-sep" />
                <button
                  class="crumb"
                  :class="{ 'is-current': crumb.path === currentFolder }"
                  @click="goToFolder(crumb.path)"
                >
                  {{ crumb.name }}
                </button>
              </template>
            </nav>
            <span v-if="!searching" class="path-summary">
              {{ t('knowledge.docs.folderSummary', {
                folders: folderRows.length,
                files: store.docQuery.total,
              }) }}
            </span>
          </div>

          <!-- 文档表格 -->
          <div class="card">
            <table class="docs-table">
              <thead>
                <tr>
                  <th v-if="!readonly" class="col-check">
                    <input
                      type="checkbox"
                      class="row-check"
                      :checked="allSelected"
                      @change="toggleSelectAll"
                    />
                  </th>
                  <th class="col-doc">{{ t('knowledge.docs.colDoc') }}</th>
                  <th class="col-size">{{ t('knowledge.common.size') }}</th>
                  <th class="col-chunks">{{ t('knowledge.common.chunks') }}</th>
                  <th class="col-er">{{ t('knowledge.docs.colEntitiesRelations') }}</th>
                  <th class="col-status">{{ t('knowledge.common.status') }}</th>
                  <th class="col-action">{{ t('knowledge.common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <!-- 目录行：与文件同表，但**不参与**勾选/批量/分页。勾选列渲染空单元格
                     而不是复选框，于是"行数 = 勾选框数"的既有约束在加了目录之后依然成立 -->
                <tr
                  v-for="folder in folderRows"
                  :key="`dir:${folder.path}`"
                  class="folder-row"
                  role="button"
                  tabindex="0"
                  :aria-label="t('knowledge.docs.enterFolder', { name: folder.name })"
                  @click="goToFolder(folder.path)"
                  @keydown.enter="goToFolder(folder.path)"
                >
                  <td v-if="!readonly" class="col-check"></td>
                  <td>
                    <div class="doc-cell">
                      <Folder :size="16" class="doc-type-icon folder-icon" />
                      <div class="doc-cell-info">
                        <div class="doc-cell-name">{{ folder.name }}</div>
                        <div class="doc-cell-date">
                          {{ t('knowledge.docs.folderFiles', { n: folderTotal(folder.path) }) }}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td class="cell-text">-</td>
                  <td class="cell-text">-</td>
                  <td class="cell-text">-</td>
                  <td class="col-status"></td>
                  <td class="col-action"></td>
                </tr>

                <tr
                  v-for="doc in filteredDocs"
                  :key="doc.id"
                  :class="['doc-row', { 'doc-row--sel': selectedDoc?.id === doc.id }]"
                >
                  <td v-if="!readonly" class="col-check">
                    <input
                      type="checkbox"
                      class="row-check"
                      :checked="selected.has(doc.id)"
                      @click.stop
                      @change="toggleSelect(doc.id)"
                    />
                  </td>
                  <td>
                    <!-- 文档名可点：在问答区打开这篇的预览标签（与右侧"查看详情"同一入口） -->
                    <div
                      class="doc-cell doc-cell--clickable"
                      role="button"
                      tabindex="0"
                      :aria-label="t('knowledge.docs.previewContent', { name: doc.name })"
                      @click="handleViewDetail(doc)"
                      @keydown.enter="handleViewDetail(doc)"
                    >
                      <component :is="docTypeIcons[doc.type]" :size="16" class="doc-type-icon" />
                      <div class="doc-cell-info">
                        <div class="doc-cell-name">{{ doc.name }}</div>
                        <!-- 搜索是跨目录的：结果里必须标出这一篇在哪个目录，
                             否则用户会以为"同一个文件出现了好几次" -->
                        <div v-if="searching" class="doc-cell-date">
                          {{ t('knowledge.docs.location', { path: locationOf(doc) }) }}
                        </div>
                        <div v-else class="doc-cell-date">{{ doc.uploadedAt }}</div>
                      </div>
                    </div>
                  </td>
                  <td class="cell-text">{{ doc.size }}</td>
                  <td class="cell-text">{{ doc.chunks || '-' }}</td>
                  <td class="cell-text">{{ doc.entities || '-' }} / {{ doc.relations || '-' }}</td>
                  <td
                    class="col-status"
                    role="button"
                    tabindex="0"
                    :aria-label="`查看《${doc.name}》的索引情况`"
                    @click.stop="toggleDocPanel(doc)"
                    @keydown.enter.stop="toggleDocPanel(doc)"
                    @keydown.space.prevent.stop="toggleDocPanel(doc)"
                  >
                    <div class="status-cell">
                      <el-tooltip
                        v-if="doc.status === 'failed' && doc.errorMessage"
                        :content="doc.errorMessage"
                        placement="top"
                        :show-after="300"
                      >
                        <KbDocStatusBadge :status="doc.status" />
                      </el-tooltip>
                      <KbDocStatusBadge v-else :status="doc.status" />
                      <el-tooltip
                        v-if="doc.graphError"
                        :content="`图谱未生成：${doc.graphError}`"
                        placement="top"
                        :show-after="300"
                      >
                        <CircleAlert :size="13" class="graph-warn" />
                      </el-tooltip>
                      <!-- 解析部分成功：索引是成功的，但内容不完整（如 OCR 到上限
                           只识别了前 N 页）。不给提示的话，"后半本检索不到"会变成
                           一个无从解释的现象。 -->
                      <el-tooltip
                        v-if="doc.parseWarning"
                        :content="doc.parseWarning"
                        placement="top"
                        :show-after="300"
                      >
                        <ScanText :size="13" class="graph-warn" />
                      </el-tooltip>
                      <el-progress
                        v-if="isActive(doc.status) && doc.status !== 'queued'"
                        :percentage="Math.round(doc.progress)"
                        :stroke-width="3"
                        :show-text="false"
                        class="inline-progress"
                      />
                    </div>
                  </td>
                  <td class="col-action">
                    <div class="action-row">
                      <el-tooltip content="查看详情" placement="top" :show-after="300">
                        <button class="action-btn action-view" @click.stop="handleViewDetail(doc)" title="查看详情" aria-label="查看详情">
                          <Eye :size="14" />
                        </button>
                      </el-tooltip>
                      <!-- 下载原文是读操作：能看正文的人就能下载，不受 readonly 限制 -->
                      <el-tooltip content="下载原文" placement="top" :show-after="300">
                        <button class="action-btn" @click.stop="handleDownload(doc)" title="下载原文" aria-label="下载原文">
                          <Download :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip v-if="!readonly" content="编辑分片" placement="top" :show-after="300">
                        <button
                          class="action-btn action-edit"
                          @click.stop="handleEditFragment(doc)"
                          title="编辑分片"
                          :disabled="doc.status === 'failed'"
                         aria-label="编辑分片">
                          <Scissors :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip
                        v-if="!readonly && canRetry(doc.status)"
                        content="重试"
                        placement="top"
                        :show-after="300"
                      >
                        <button
                          class="action-btn"
                          @click.stop="handleRetry(doc.id)"
                          title="重试"
                         aria-label="重试">
                          <RefreshCw :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip
                        v-if="!readonly && isActive(doc.status)"
                        content="取消索引"
                        placement="top"
                        :show-after="300"
                      >
                        <button
                          class="action-btn"
                          @click.stop="handleCancel(doc.id)"
                          title="取消索引"
                         aria-label="取消索引">
                          <Ban :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip v-if="!readonly" content="删除" placement="top" :show-after="300">
                        <button class="action-btn action-del" @click.stop="handleDelete(doc.id)" title="删除" aria-label="删除">
                          <Trash2 :size="14" />
                        </button>
                      </el-tooltip>
                    </div>
                  </td>
                </tr>
                <!-- 加载中不显示空态：此前没有加载态，"暂无文档，点击右上角上传"这个
                     行动号召会在数据还在路上时先冒出来，误导用户去重复上传 -->
                <tr
                  v-if="store.docQuery.loading && filteredDocs.length === 0
                    && folderRows.length === 0"
                >
                  <td :colspan="readonly ? 6 : 7" class="empty-cell">
                    <KbSkeleton :rows="3" />
                  </td>
                </tr>
                <tr v-else-if="filteredDocs.length === 0 && folderRows.length === 0">
                  <td :colspan="readonly ? 6 : 7" class="empty-cell">
                    <FolderOpen :size="32" class="empty-icon" />
                    <p v-if="searching">没有名称匹配「{{ store.docQuery.search }}」的文档</p>
                    <!-- 目录里为空是另一回事：这里**不能**出现"点击右上角上传"这种
                         行动号召之外的说法，也不能与"整个库是空的"共用一句话 -->
                    <p v-else-if="currentFolder">
                      {{ t('knowledge.docs.folderEmpty', { path: currentFolder }) }}
                    </p>
                    <p v-else>{{ readonly ? '暂无文档' : '暂无文档，点击右上角上传' }}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 分页器：只有真的超过一页才出现。此前写死 page_size=100 且丢掉 total，
               超过 100 篇的库静默只显示前 100 篇、没有任何提示。
               计数口径是**当前目录**（搜索时是搜索结果），所以文案要说清 -->
          <div v-if="store.docQuery.total > store.docQuery.pageSize" class="docs-pager">
            <span class="docs-pager-total">
              {{ searching
                ? t('knowledge.docs.searchTotal', { n: store.docQuery.total })
                : t('knowledge.docs.folderTotal', { n: store.docQuery.total }) }}
            </span>
            <el-pagination
              layout="prev, pager, next"
              background
              :current-page="store.docQuery.page"
              :page-size="store.docQuery.pageSize"
              :total="store.docQuery.total"
              @current-change="(p: number) => store.loadDocs(props.kb.id, { page: p })"
            />
          </div>
        </div>

        <!-- 索引流水线面板 -->
        <div v-if="selectedDoc" class="docs-panel">
          <KbIndexingPipeline :doc="selectedDoc" @close="selectedDocId = null" />
        </div>
      </div>

      <!-- 上传过程由对话框自己驱动（逐文件进度只在那里看得到），
           父组件只负责开与关。关闭时重取列表与目录树：整目录上传的文档落在子目录里，
           不会出现在当前列表里（store 只前插"属于当前目录"的那些） -->
      <KbUploadDialog
        :visible="uploadVisible"
        :default-config="kb.config"
        :kb-id="kb.id"
        :folder="currentFolder"
        @close="uploadVisible = false; refreshAfterUpload()"
      />

      <KbPasteTextDialog
        :visible="pasteVisible"
        :default-config="kb.config"
        @close="pasteVisible = false"
        @submit="handlePaste"
      />

      <KbUrlImportDialog
        :visible="urlVisible"
        :default-config="kb.config"
        :error="urlError"
        @close="urlVisible = false"
        @submit="handleUrlImport"
      />
    </template>
  </div>
</template>

<style scoped>
.docs-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 4px 2px;
}

.docs-pager-total {
  font-size: 12px;
  color: var(--foreground-muted);
}

.docs-tab {
  width: 100%;
  height: 100%;
}

.docs-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  transition: grid-template-columns 0.2s;
  height: 100%;
}

.docs-layout.has-panel {
  grid-template-columns: 7fr 5fr;
}

.docs-table-area {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  min-height: 0;
}

.docs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-wrap {
  position: relative;
  flex: 1;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--foreground-secondary);
  pointer-events: none;
  z-index: 1;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 36px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input);
  color: var(--foreground-primary);
  font-size: var(--font-size-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}

.search-input::placeholder {
  color: var(--foreground-muted);
}

.search-input:focus {
  border-color: rgba(59, 130, 246, 0.4);
}

/* ── 路径条：当前位置 + 上一级 ── */
.path-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 26px;
  font-size: var(--font-size-xs);
}

.path-up {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 4px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.path-up:hover {
  color: var(--foreground-primary);
  border-color: var(--border-medium);
}

.crumbs {
  /* flex:1 不能省：只写 min-width:0 时面包屑不会长进剩余空间，
     实测会被压成 64px，只剩最后一个字可见（"根目录" → "录"）。
     路径很长时由它的 overflow-x 自己滚动，右侧计数始终留在原位 */
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.crumb:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.crumb.is-current {
  color: var(--foreground-primary);
  font-weight: var(--font-weight-medium);
}

.crumb-sep {
  flex-shrink: 0;
  color: var(--foreground-muted);
}

.path-summary {
  flex: 0 0 auto;
  color: var(--foreground-muted);
}

/* 目录行：可进入，但不参与勾选/批量 */
.folder-row {
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid var(--border-subtle);
}

.folder-row:hover {
  background: var(--surface-secondary);
}

.folder-row:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
}

.folder-icon {
  color: #fcd34d;
}

.btn-upload {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  border: none;
  border-radius: var(--radius-input);
  color: #fff;
  font-size: var(--font-size-base);
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.btn-upload:hover {
  opacity: 0.9;
}

.btn-upload:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 次要按钮（粘贴文本 / 批量重试）：与主按钮同尺寸但弱化，避免一排实心按钮 */
.btn-secondary {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  color: var(--foreground-primary);
}

/* 危险操作（批量删除）：红字描边，不抢主按钮的视觉位 */
.btn-danger {
  background: var(--surface-card);
  border: 1px solid var(--el-color-danger, #f56c6c);
  color: var(--el-color-danger, #f56c6c);
}

.col-check {
  width: 36px;
  text-align: center;
}

.row-check {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--el-color-primary, #409eff);
}

.card {
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  overflow: hidden;
  flex: 1;
  min-height: 0;
}

/* Table */
.docs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}

.docs-table thead {
  background: var(--surface-secondary);
}

.docs-table thead th {
  padding: 10px 16px;
  text-align: left;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-secondary);
  white-space: nowrap;
  border-bottom: 1px solid var(--border-subtle);
}

.docs-table thead th.col-action {
  text-align: right;
}

.doc-row {
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid var(--border-subtle);
}

.doc-row:last-child {
  border-bottom: none;
}

.doc-row:hover {
  background: var(--surface-secondary);
}

.doc-row--sel {
  background: rgba(59, 130, 246, 0.08);
}

.docs-table td {
  padding: 12px 16px;
  vertical-align: middle;
}

.col-doc { min-width: 240px; }
.col-size { width: 90px; }
.col-chunks { width: 70px; }
.col-er { width: 100px; }
.col-status { width: 180px; cursor: pointer; }
.col-status:hover { background: rgba(59, 130, 246, 0.06); }
.col-action { width: 150px; text-align: right; }

.graph-warn {
  color: var(--status-warning-text, #f59e0b);
  flex-shrink: 0;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  white-space: nowrap;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  background: var(--surface-secondary);
  color: var(--foreground-primary);
}

.action-view {
  color: var(--accent-primary);
}

.action-view:hover {
  background: rgba(59, 130, 246, 0.15);
  color: var(--accent-primary);
}

.action-edit {
  color: var(--status-purple-text);
}

.action-edit:hover {
  background: rgba(139, 92, 246, 0.15);
  color: var(--status-purple-text);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-btn:disabled:hover {
  background: transparent;
  color: var(--foreground-secondary);
}

.action-del:hover {
  color: var(--status-error-text);
  background: rgba(244, 63, 94, 0.12);
}

.doc-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-cell--clickable {
  cursor: pointer;
}

.doc-cell--clickable:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.doc-type-icon {
  color: var(--foreground-secondary);
  flex-shrink: 0;
}

.doc-cell-info {
  min-width: 0;
}

.doc-cell-name {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-cell-date {
  font-size: 10px;
  color: var(--foreground-muted);
}

.cell-text {
  font-size: var(--font-size-sm);
  color: var(--foreground-primary);
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inline-progress {
  width: 100px;
}

.empty-cell {
  text-align: center;
  padding: 48px 0 !important;
  color: var(--foreground-muted);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.empty-cell p {
  margin: 0;
  font-size: var(--font-size-sm);
}

.docs-panel {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.btn-icon {
  margin-right: 4px;
}

/*
 * 窄屏（<768）：文档表在手机宽度下会被挤成一团，改为容器内横向滚动。
 * 与 KnowledgeBaseView 里同款规则一致——理由见那边的注释（普通 CSS 而非 mixin）。
 */
@media (max-width: 767px) {
  .card {
    overflow-x: auto;
  }

  .docs-table {
    min-width: 760px;
  }
}
</style>
