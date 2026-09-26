<script setup lang="ts">
import { ref, watch, computed, reactive } from 'vue'
import { Upload, X, FileType2, FileCode2, FileText, FileSpreadsheet, FileImage, Globe, FolderOpen } from 'lucide-vue-next'
import type { DocType, IndexConfig } from '@/types/knowledgeBase'
import { DOC_TYPE_CONFIG } from '@/types/knowledgeBase'
import { useKnowledgeBaseStore, type UploadFileState } from '@/stores/knowledgeBase'
import KbIndexConfigForm from './KbIndexConfigForm.vue'

const props = defineProps<{
  visible: boolean
  defaultConfig: IndexConfig
  kbId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useKnowledgeBaseStore()

/** 待上传条目：`display` 是展示名（目录上传时带相对路径），上传仍用 `file.name` */
interface Entry {
  file: File
  display: string
  tooLarge: boolean
  state: UploadFileState
}

const dialogVisible = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const entries = ref<Entry[]>([])
const indexMode = ref<'kb' | 'custom'>('kb')
let customConfig = reactive<IndexConfig>({ ...props.defaultConfig })

const uploading = ref(false)
const finished = ref(false)

const docTypeIcons: Record<DocType, typeof FileText> = {
  pdf: FileType2, md: FileCode2, docx: FileText, csv: FileSpreadsheet, image: FileImage, html: Globe,
}

const ALLOWED_TYPES = '.pdf,.docx,.xlsx,.pptx,.csv,.json,.md,.html,.txt,.png,.jpg,.jpeg'
//: 与后端 KB_MAX_FILE_MB（core/config.py，默认 100）一致；后端才是权威，
//: 这里只为了在清单里提前标注，不再像以前那样**静默丢弃**
const MAX_FILE_MB = 100

const uploadable = computed(() => entries.value.filter((e) => !e.tooLarge))
const hasFiles = computed(() => uploadable.value.length > 0)
const dialogWidth = computed(() => (indexMode.value === 'custom' ? '760px' : '560px'))

const summary = computed(() => {
  const done = entries.value.filter((e) => e.state.status === 'done').length
  const skipped = entries.value.filter((e) => e.state.status === 'skipped').length
  const failed = entries.value.filter((e) => e.state.status === 'failed').length
  return { done, skipped, failed }
})

const failedEntries = computed(() => entries.value.filter((e) => e.state.status === 'failed' && !e.tooLarge))

const canRetry = computed(() => finished.value && failedEntries.value.length > 0 && !uploading.value)

watch(() => props.visible, (v) => {
  dialogVisible.value = v
  if (v) reset()
})

watch(indexMode, (mode) => {
  if (mode === 'custom') Object.assign(customConfig, props.defaultConfig)
})

function reset() {
  entries.value = []
  indexMode.value = 'kb'
  uploading.value = false
  finished.value = false
  Object.assign(customConfig, props.defaultConfig)
}

function handleClose() {
  dialogVisible.value = false
  emit('close')
}

function getFileType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext && ext in DOC_TYPE_CONFIG ? ext : 'md'
}

function getFileIcon(name: string) {
  const ft = getFileType(name) as DocType
  return docTypeIcons[ft] || FileText
}

function getFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function addFiles(list: FileList | null) {
  if (!list) return
  for (let i = 0; i < list.length; i++) {
    const file = list[i]
    const tooLarge = file.size > MAX_FILE_MB * 1024 * 1024
    entries.value.push({
      file,
      // 目录上传时保留相对路径做展示（后端只存基名，重名由后端加序号区分）
      display: file.webkitRelativePath || file.name,
      tooLarge,
      state: {
        name: file.name,
        status: tooLarge ? 'failed' : 'pending',
        percent: 0,
        message: tooLarge ? `超过 ${MAX_FILE_MB}MB 上限，不会上传` : undefined,
      },
    })
  }
}

function triggerFileInput() {
  fileInput.value?.click()
}

function triggerFolderInput() {
  folderInput.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  addFiles(input.files)
  input.value = ''
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  addFiles(e.dataTransfer?.files ?? null)
}

function removeFile(index: number) {
  entries.value = entries.value.filter((_, i) => i !== index)
}

async function runUpload(files: File[]) {
  uploading.value = true
  finished.value = false
  try {
    await store.uploadDocs(props.kbId, files, indexMode.value === 'custom' ? { ...customConfig } : undefined, {
      onFileState: (state) => {
        // 回调里只有名字，按名字找条目回填进度
        for (const entry of entries.value) {
          if (entry.file.name === state.name && !entry.tooLarge) {
            entry.state = { ...entry.state, ...state }
          }
        }
      },
    })
  } finally {
    uploading.value = false
    finished.value = true
  }
}

async function handleUpload() {
  if (!hasFiles.value) return
  await runUpload(uploadable.value.map((e) => e.file))
}

async function handleRetryFailed() {
  const files = failedEntries.value.map((e) => e.file)
  if (!files.length) return
  await runUpload(files)
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :width="dialogWidth"
    :close-on-click-modal="false"
    @close="handleClose"
    class="upload-doc-dialog"
    destroy-on-close
  >
    <template #header>
      <div class="dialog-header">
        <h2 class="dialog-title">上传文档</h2>
        <p class="dialog-desc">支持 PDF / Word / Markdown / HTML / CSV / JSON / TXT / 图片，可整个文件夹上传</p>
      </div>
    </template>

    <div class="dialog-body">
      <!-- 文件 / 文件夹选择 -->
      <input
        ref="fileInput"
        type="file"
        :accept="ALLOWED_TYPES"
        multiple
        style="display: none"
        @change="handleFileChange"
      />
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        style="display: none"
        @change="handleFileChange"
      />

      <!-- 拖拽区 -->
      <div
        class="dropzone"
        @click="triggerFileInput"
        @dragover="handleDragOver"
        @drop="handleDrop"
      >
        <Upload :size="32" class="dropzone-icon" />
        <div class="dropzone-text">拖拽文件到此处或点击选择</div>
        <div class="dropzone-sub">单文件最大 {{ MAX_FILE_MB }}MB；也可以整目录上传</div>
        <button class="dropzone-folder" type="button" @click.stop="triggerFolderInput">
          <FolderOpen :size="14" />选择文件夹
        </button>
      </div>

      <!-- 汇总：上传中与结束后各显示一次，用户不用自己数 -->
      <div v-if="uploading || finished" class="upload-summary">
        <span>{{ uploading ? '上传中…' : '上传完成' }}</span>
        <span>成功 {{ summary.done }} · 跳过 {{ summary.skipped }} · 失败 {{ summary.failed }}</span>
      </div>

      <!-- 文件列表 + 逐文件状态 -->
      <div v-if="entries.length" class="file-list">
        <div v-for="(entry, i) in entries" :key="i" class="file-item">
          <component :is="getFileIcon(entry.file.name)" :size="16" class="file-item-icon" />
          <span class="file-item-name" :title="entry.display">{{ entry.display }}</span>
          <span class="file-item-size">{{ getFileSize(entry.file.size) }}</span>
          <span class="file-item-state" :class="`is-${entry.state.status}`">
            <template v-if="entry.state.status === 'uploading'">
              {{ entry.state.percent }}%
            </template>
            <template v-else-if="entry.state.status === 'done'">已入队</template>
            <template v-else-if="entry.state.status === 'skipped'">
              已跳过{{ entry.state.message ? `（${entry.state.message}）` : '' }}
            </template>
            <template v-else-if="entry.state.status === 'failed'">
              {{ entry.state.message || '失败' }}
            </template>
            <template v-else>待上传</template>
          </span>
          <el-progress
            v-if="entry.state.status === 'uploading'"
            :percentage="entry.state.percent"
            :stroke-width="3"
            :show-text="false"
            class="file-item-progress"
          />
          <button v-if="!uploading" class="file-item-del" @click="removeFile(i)">
            <X :size="14" />
          </button>
        </div>
      </div>

      <!-- 自定义索引配置 -->
      <div v-if="indexMode === 'custom'" class="custom-config-section">
        <div class="config-section-title">自定义索引配置</div>
        <KbIndexConfigForm v-model="customConfig" />
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-radio-group v-model="indexMode" size="small" class="index-mode-radio" :disabled="uploading">
          <el-radio value="kb">使用知识库索引</el-radio>
          <el-radio value="custom">自定义索引</el-radio>
        </el-radio-group>
        <div class="footer-buttons">
          <button v-if="canRetry" class="btn-cancel" @click="handleRetryFailed">
            重试失败项 ({{ failedEntries.length }})
          </button>
          <button v-if="!finished" class="btn-upload" :disabled="!hasFiles || uploading" @click="handleUpload">
            <Upload :size="16" />{{ uploading ? '上传中…' : `开始索引 (${uploadable.length})` }}
          </button>
          <button v-else class="btn-upload" @click="handleClose">完成</button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ─── Header ─── */
.dialog-header {
  padding: 0;
}

.dialog-title {
  font-size: 17px;
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  margin: 0;
}

.dialog-desc {
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  margin: 6px 0 0;
}

/* ─── Body ─── */
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 16px;
  border: 1px dashed var(--border-color, #dcdfe6);
  border-radius: 8px;
  cursor: pointer;
  color: var(--foreground-secondary);
}

.dropzone-icon {
  color: var(--el-color-primary, #409eff);
}

.dropzone-text {
  font-size: var(--font-size-base);
  color: var(--foreground-primary);
}

.dropzone-sub {
  font-size: var(--font-size-sm);
}

.dropzone-folder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border-color, #dcdfe6);
  border-radius: 6px;
  background: transparent;
  color: var(--foreground-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.upload-summary {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-sm);
  color: var(--foreground-secondary);
  padding: 8px 10px;
  background: var(--el-fill-color-light, #f5f7fa);
  border-radius: 6px;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-sm);
  flex-wrap: wrap;
}

.file-item-icon {
  color: var(--foreground-secondary);
  flex-shrink: 0;
}

.file-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--foreground-primary);
}

.file-item-size {
  color: var(--foreground-secondary);
  flex-shrink: 0;
}

.file-item-state {
  flex-shrink: 0;
  font-size: var(--font-size-xs, 12px);
  color: var(--foreground-secondary);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-item-state.is-done {
  color: var(--el-color-success, #67c23a);
}

.file-item-state.is-skipped {
  color: var(--el-color-warning, #e6a23c);
}

.file-item-state.is-failed {
  color: var(--el-color-danger, #f56c6c);
}

.file-item-progress {
  width: 100%;
}

.file-item-del {
  display: inline-flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--foreground-secondary);
  cursor: pointer;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.footer-buttons {
  display: flex;
  gap: 8px;
}

.btn-cancel,
.btn-upload {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-cancel {
  background: transparent;
  border-color: var(--border-color, #dcdfe6);
  color: var(--foreground-secondary);
}

.btn-upload {
  background: var(--el-color-primary, #409eff);
  color: #fff;
}

.btn-upload:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.custom-config-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-section-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--foreground-primary);
}
</style>
