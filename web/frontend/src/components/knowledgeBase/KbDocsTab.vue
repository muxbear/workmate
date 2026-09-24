<script setup lang="ts">
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Search, Upload, Trash2, RefreshCw, FolderOpen, Ban, CircleAlert,
  FileType2, FileCode2, FileText, FileSpreadsheet, FileImage, Globe,
  Eye, Scissors,
} from 'lucide-vue-next'
import type { KB, KBDoc, DocType, IndexConfig } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBase'
import KbDocStatusBadge from './KbDocStatusBadge.vue'
import KbUploadDialog from './KbUploadDialog.vue'
import KbIndexingPipeline from './KbIndexingPipeline.vue'
import KbDocDetailDrawer from './KbDocDetailDrawer.vue'
import KbFragmentEditor from './KbFragmentEditor.vue'

const props = defineProps<{
  kb: KB
  /** 只读态（公共库 / 他人分享）：隐藏上传、删除、重试与切片编辑 */
  readonly?: boolean
}>()

// 注意：computed 必须在 props 之后定义（下面 selectedDoc 会用到 props.kb）

const store = useKnowledgeBaseStore()

const search = ref('')
const uploadVisible = ref(false)
// 只存 id，面板用 computed 从最新列表里取——列表在 SSE/轮询后会被整体替换，
// 若这里存对象引用，面板会永远显示打开那一刻的快照（行徽标却在更新，自相矛盾）
const selectedDocId = ref<string | null>(null)

const selectedDoc = computed(
  () => props.kb.documents.find((d) => d.id === selectedDocId.value) ?? null,
)
const detailDoc = ref<KBDoc | null>(null)
const editDoc = ref<KBDoc | null>(null)

const docTypeIcons: Record<DocType, typeof FileText> = {
  pdf: FileType2, md: FileCode2, docx: FileText, csv: FileSpreadsheet, image: FileImage, html: Globe,
}

const filteredDocs = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.kb.documents
  return props.kb.documents.filter((d) => d.name.toLowerCase().includes(q))
})

const uploading = ref(false)

async function handleUpload(files: File[], config?: IndexConfig) {
  uploadVisible.value = false
  try {
    uploading.value = true
    await store.uploadDocs(props.kb.id, files, config)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '上传失败'
    ElMessage.error(msg)
  } finally {
    uploading.value = false
  }
}

async function handleDelete(docId: string) {
  try {
    await store.deleteDoc(props.kb.id, docId)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(msg)
  }
}

async function handleRetry(docId: string) {
  try {
    await store.retryDoc(props.kb.id, docId)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '重试失败'
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
    const msg = err instanceof Error ? err.message : '取消失败'
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
  detailDoc.value = doc
}

function handleEditFragment(doc: KBDoc) {
  editDoc.value = doc
}
</script>

<template>
  <div class="docs-tab">
    <!-- 查看详情 (full-page inline view) -->
    <KbDocDetailDrawer
      v-if="detailDoc"
      :doc="detailDoc"
      :kb-id="kb.id"
      @back="detailDoc = null"
    />

    <!-- 编辑分片 (full-page inline view) -->
    <KbFragmentEditor
      v-else-if="editDoc"
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
                v-model="search"
                type="text"
                placeholder="检索文档…"
                class="search-input"
              />
            </div>
            <button
              v-if="!readonly"
              class="btn-upload"
              :disabled="uploading"
              @click="uploadVisible = true"
            >
              <Upload :size="16" class="btn-icon" />{{ uploading ? '上传中…' : '上传文档' }}
            </button>
          </div>

          <!-- 文档表格 -->
          <div class="card">
            <table class="docs-table">
              <thead>
                <tr>
                  <th class="col-doc">文档</th>
                  <th class="col-size">大小</th>
                  <th class="col-chunks">分片</th>
                  <th class="col-er">实体/关系</th>
                  <th class="col-status">状态</th>
                  <th class="col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="doc in filteredDocs"
                  :key="doc.id"
                  :class="['doc-row', { 'doc-row--sel': selectedDoc?.id === doc.id }]"
                >
                  <td>
                    <div class="doc-cell">
                      <component :is="docTypeIcons[doc.type]" :size="16" class="doc-type-icon" />
                      <div class="doc-cell-info">
                        <div class="doc-cell-name">{{ doc.name }}</div>
                        <div class="doc-cell-date">{{ doc.uploadedAt }}</div>
                      </div>
                    </div>
                  </td>
                  <td class="cell-text">{{ doc.size }}</td>
                  <td class="cell-text">{{ doc.chunks || '-' }}</td>
                  <td class="cell-text">{{ doc.entities || '-' }} / {{ doc.relations || '-' }}</td>
                  <td class="col-status" @click.stop="toggleDocPanel(doc)">
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
                        <button class="action-btn action-view" @click.stop="handleViewDetail(doc)" title="查看详情">
                          <Eye :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip v-if="!readonly" content="编辑分片" placement="top" :show-after="300">
                        <button
                          class="action-btn action-edit"
                          @click.stop="handleEditFragment(doc)"
                          title="编辑分片"
                          :disabled="doc.status === 'failed'"
                        >
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
                        >
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
                        >
                          <Ban :size="14" />
                        </button>
                      </el-tooltip>
                      <el-tooltip v-if="!readonly" content="删除" placement="top" :show-after="300">
                        <button class="action-btn action-del" @click.stop="handleDelete(doc.id)" title="删除">
                          <Trash2 :size="14" />
                        </button>
                      </el-tooltip>
                    </div>
                  </td>
                </tr>
                <tr v-if="filteredDocs.length === 0">
                  <td colspan="6" class="empty-cell">
                    <FolderOpen :size="32" class="empty-icon" />
                    <p>{{ readonly ? '暂无文档' : '暂无文档，点击右上角上传' }}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 索引流水线面板 -->
        <div v-if="selectedDoc" class="docs-panel">
          <KbIndexingPipeline :doc="selectedDoc" @close="selectedDocId = null" />
        </div>
      </div>

      <KbUploadDialog
        :visible="uploadVisible"
        :default-config="kb.config"
        @close="uploadVisible = false"
        @upload="handleUpload"
      />
    </template>
  </div>
</template>

<style scoped>
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
</style>
