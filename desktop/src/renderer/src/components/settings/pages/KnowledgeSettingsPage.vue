<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import SettingToggle from '../SettingToggle.vue'
import { useModelStore } from '../../../store/models'
import { useSettingsStore, type ChunkStrategy, type SettingsKey, type VectorDimensions } from '../../../store/settings'

const settingsStore = useSettingsStore()
const modelStore = useModelStore()

/** 数值草稿字段（输入框统一以字符串承接，保存时校验转换） */
type NumericDraftKey =
  | 'maxUploadSize'
  | 'uploadTimeout'
  | 'maxFilesPerBatch'
  | 'chunkSize'
  | 'chunkOverlap'
  | 'bm25K1'
  | 'bm25B'
  | 'hybridWeight'
  | 'topK'

/** 表单草稿：进入页面时由 store 回填，点「保存设置」才写回主进程 */
const draft = reactive({
  directory: '',
  maxUploadSize: '100',
  uploadTimeout: '10',
  maxFilesPerBatch: '20',
  chunkStrategy: 'semantic' as ChunkStrategy,
  chunkSize: '800',
  chunkOverlap: '120',
  vectorDimensions: 1024 as VectorDimensions,
  embeddingModel: 'text-embedding-3-large',
  sparseRetrieval: true,
  bm25K1: '1.5',
  bm25B: '0.75',
  hybridWeight: '0.65',
  rerankEnabled: true,
  rerankModel: 'bge-reranker-v2-m3',
  topK: '12',
  graphEnabled: false,
  graphModel: 'GLM-5'
})

const CHUNK_STRATEGY_OPTIONS: Array<{ value: ChunkStrategy; label: string }> = [
  { value: 'semantic', label: '智能语义切分' },
  { value: 'fixed', label: '固定长度切分' },
  { value: 'markdown', label: '按 Markdown 标题切分' },
  { value: 'recursive', label: '递归字符切分' }
]

const VECTOR_DIMENSION_OPTIONS: VectorDimensions[] = [1024, 1536, 3072]
const EMBEDDING_MODEL_OPTIONS = ['text-embedding-3-large', 'bge-m3']
const RERANK_MODEL_OPTIONS = ['bge-reranker-v2-m3', 'gte-reranker-modernbert-base']
const GRAPH_MODEL_OPTIONS = ['GLM-5', 'DeepSeek-V4-Pro 原厂直供']

/** 数值项定义：草稿字段 → 设置 key + 区间（与主进程 schema 校验保持一致） */
const NUMBER_FIELDS: Array<{
  draftKey: NumericDraftKey
  key: SettingsKey
  label: string
  min: number
  max: number
  integer: boolean
}> = [
  { draftKey: 'maxUploadSize', key: 'knowledge.maxUploadSize', label: '单文件最大大小', min: 1, max: 10240, integer: true },
  { draftKey: 'uploadTimeout', key: 'knowledge.uploadTimeout', label: '上传超时', min: 1, max: 600, integer: true },
  { draftKey: 'maxFilesPerBatch', key: 'knowledge.maxFilesPerBatch', label: '单批次文件数', min: 1, max: 1000, integer: true },
  { draftKey: 'chunkSize', key: 'knowledge.chunkSize', label: '切片大小', min: 100, max: 8192, integer: true },
  { draftKey: 'chunkOverlap', key: 'knowledge.chunkOverlap', label: '重叠大小', min: 0, max: 4096, integer: true },
  { draftKey: 'bm25K1', key: 'knowledge.bm25K1', label: 'BM25 k1', min: 0, max: 10, integer: false },
  { draftKey: 'bm25B', key: 'knowledge.bm25B', label: 'BM25 b', min: 0, max: 1, integer: false },
  { draftKey: 'hybridWeight', key: 'knowledge.hybridWeight', label: '向量检索权重', min: 0, max: 1, integer: false },
  { draftKey: 'topK', key: 'knowledge.topK', label: '召回 Top', min: 1, max: 100, integer: true }
]

/** 自定义模型名（models.json；排除已内置的选项，供各模型下拉追加） */
const customModelNames = computed(() => {
  const builtin = new Set([...EMBEDDING_MODEL_OPTIONS, ...RERANK_MODEL_OPTIONS, ...GRAPH_MODEL_OPTIONS])
  const names = modelStore.models.map((m) => m.name).filter((n) => n && !builtin.has(n))
  return [...new Set(names)]
})

/** 从 store 同步草稿（挂载时、以及主进程设置加载完成后回填） */
function syncFromStore(): void {
  const s = settingsStore
  // 设置为空时回填主进程解析的默认目录（与设计稿一致：输入框展示具体路径而非占位符）
  draft.directory = s.knowledgeDirectory || s.meta?.defaultKnowledgeDir || ''
  draft.maxUploadSize = String(s.knowledgeMaxUploadSize)
  draft.uploadTimeout = String(s.knowledgeUploadTimeout)
  draft.maxFilesPerBatch = String(s.knowledgeMaxFilesPerBatch)
  draft.chunkStrategy = s.knowledgeChunkStrategy
  draft.chunkSize = String(s.knowledgeChunkSize)
  draft.chunkOverlap = String(s.knowledgeChunkOverlap)
  draft.vectorDimensions = s.knowledgeVectorDimensions
  draft.embeddingModel = s.knowledgeEmbeddingModel
  draft.sparseRetrieval = s.knowledgeSparseRetrieval
  draft.bm25K1 = String(s.knowledgeBm25K1)
  draft.bm25B = String(s.knowledgeBm25B)
  draft.hybridWeight = String(s.knowledgeHybridWeight)
  draft.rerankEnabled = s.knowledgeRerankEnabled
  draft.rerankModel = s.knowledgeRerankModel
  draft.topK = String(s.knowledgeTopK)
  draft.graphEnabled = s.knowledgeGraphEnabled
  draft.graphModel = s.knowledgeGraphModel
}

onMounted(() => {
  syncFromStore()
  void modelStore.load()
})

// 主进程设置加载可能晚于本页挂载，加载完成后回填草稿
watch(
  () => settingsStore.loaded,
  (ready) => {
    if (ready) syncFromStore()
  }
)

/** 轻量 toast（保存反馈） */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 1800)
}

/** 数值解析 + 区间校验；非法返回 null */
function parseNumber(raw: string, min: number, max: number, integer: boolean): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  if (integer && !Number.isInteger(n)) return null
  if (n < min || n > max) return null
  return n
}

/** 组装待写入项；任一数值项非法则提示并返回 null（不保存） */
function buildPayload(): Array<[SettingsKey, unknown]> | null {
  const payload: Array<[SettingsKey, unknown]> = [
    ['knowledge.directory', draft.directory],
    ['knowledge.chunkStrategy', draft.chunkStrategy],
    ['knowledge.vectorDimensions', draft.vectorDimensions],
    ['knowledge.embeddingModel', draft.embeddingModel],
    ['knowledge.sparseRetrieval', draft.sparseRetrieval],
    ['knowledge.rerankEnabled', draft.rerankEnabled],
    ['knowledge.rerankModel', draft.rerankModel],
    ['knowledge.graphEnabled', draft.graphEnabled],
    ['knowledge.graphModel', draft.graphModel]
  ]
  for (const field of NUMBER_FIELDS) {
    const value = parseNumber(draft[field.draftKey], field.min, field.max, field.integer)
    if (value === null) {
      showToast(`保存失败：「${field.label}」需为 ${field.min}~${field.max} 之间的${field.integer ? '整数' : '数值'}`)
      return null
    }
    payload.push([field.key, value])
  }
  return payload
}

const saving = ref(false)

async function onSave(): Promise<void> {
  const payload = buildPayload()
  if (!payload) return
  saving.value = true
  const ok = await settingsStore.saveMany(payload)
  saving.value = false
  if (!ok) {
    showToast('保存失败：主进程校验未通过')
    return
  }
  syncFromStore()
  showToast('知识库设置已保存')
}

/** 选择知识库目录（系统原生对话框；取消不改动） */
async function onSelectDirectory(): Promise<void> {
  try {
    await settingsStore.changeKnowledgeDir()
    draft.directory = settingsStore.knowledgeDirectory
  } catch (err) {
    console.warn('[knowledge] select dir failed:', err)
    showToast('选择目录失败')
  }
}
</script>

<template>
  <div class="s-page kb-page">
    <!-- 说明 + 保存 -->
    <div class="kb-header">
      <div>
        <p class="kb-intro">
          这些配置将用于主页面“知识库”的文件处理、索引构建与问答检索。
        </p>
        <p class="kb-intro-sub">
          修改后仅影响后续新增或重新索引的文件。
        </p>
      </div>
      <button
        class="s-btn s-btn--primary kb-save"
        :disabled="saving"
        @click="onSave"
      >
        保存设置
      </button>
    </div>

    <!-- 本地存储 -->
    <section class="kb-card kb-card--soft">
      <div class="kb-card-head">
        <span class="kb-card-icon">
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line
              x1="22"
              x2="2"
              y1="12"
              y2="12"
            />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            <line
              x1="6"
              x2="6.01"
              y1="16"
              y2="16"
            />
            <line
              x1="10"
              x2="10.01"
              y1="16"
              y2="16"
            />
          </svg>
        </span>
        <div>
          <h2 class="kb-title">
            本地存储
          </h2>
          <p class="kb-desc">
            本地知识库原始文件、解析缓存与向量索引的存放位置。
          </p>
        </div>
      </div>
      <div class="kb-dir-row">
        <input
          v-model="draft.directory"
          class="kb-input kb-dir-input"
        >
        <button
          class="kb-btn"
          @click="onSelectDirectory"
        >
          <svg
            class="kb-btn-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
          </svg>
          选择目录
        </button>
      </div>
      <p class="kb-hint">
        建议使用本地 SSD 目录，并预留至少 5 GB 可用空间。
      </p>
    </section>

    <!-- 文件上传 -->
    <section class="kb-card">
      <h2 class="kb-title">
        文件上传
      </h2>
      <p class="kb-desc">
        限制单次导入的资源消耗，避免超大文件阻塞解析队列。
      </p>
      <div class="kb-grid kb-grid--3">
        <label class="kb-field">
          <span class="kb-label">单文件最大大小</span>
          <div class="kb-unit-box">
            <input
              v-model="draft.maxUploadSize"
              class="kb-input kb-input--bare"
            >
            <span class="kb-unit">MB</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">上传超时</span>
          <div class="kb-unit-box">
            <input
              v-model="draft.uploadTimeout"
              class="kb-input kb-input--bare"
            >
            <span class="kb-unit">分钟</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">单批次文件数</span>
          <div class="kb-unit-box">
            <input
              v-model="draft.maxFilesPerBatch"
              class="kb-input kb-input--bare"
            >
            <span class="kb-unit">个</span>
          </div>
        </label>
      </div>
    </section>

    <!-- RAG 索引 -->
    <section class="kb-card">
      <div class="kb-card-head">
        <span class="kb-card-icon">
          <svg
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
            <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
            <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
          </svg>
        </span>
        <div>
          <h2 class="kb-title">
            RAG 索引
          </h2>
          <p class="kb-desc">
            控制文档切片与向量化策略。较小切片更精确，较大切片保留更多上下文。
          </p>
        </div>
      </div>
      <div class="kb-grid kb-grid--2">
        <label class="kb-field">
          <span class="kb-label">默认切片算法</span>
          <div class="kb-select-wrap">
            <select
              v-model="draft.chunkStrategy"
              class="kb-input kb-select"
            >
              <option
                v-for="opt in CHUNK_STRATEGY_OPTIONS"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">向量化模型</span>
          <div class="kb-select-wrap">
            <select
              v-model="draft.embeddingModel"
              class="kb-input kb-select"
            >
              <option
                v-for="name in EMBEDDING_MODEL_OPTIONS"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
              <option
                v-for="name in customModelNames"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">切片大小</span>
          <div class="kb-unit-box">
            <input
              v-model="draft.chunkSize"
              class="kb-input kb-input--bare"
            >
            <span class="kb-unit">tokens</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">重叠大小</span>
          <div class="kb-unit-box">
            <input
              v-model="draft.chunkOverlap"
              class="kb-input kb-input--bare"
            >
            <span class="kb-unit">tokens</span>
          </div>
        </label>
        <label class="kb-field">
          <span class="kb-label">向量维度</span>
          <div class="kb-select-wrap">
            <select
              v-model.number="draft.vectorDimensions"
              class="kb-input kb-select"
            >
              <option
                v-for="dim in VECTOR_DIMENSION_OPTIONS"
                :key="dim"
                :value="dim"
              >
                {{ dim }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
      </div>
    </section>

    <!-- 混合检索与重排 -->
    <section class="kb-card">
      <div class="kb-card-head kb-card-head--between">
        <div>
          <h2 class="kb-title">
            混合检索与重排
          </h2>
          <p class="kb-desc">
            结合向量语义与 BM25 关键词检索，再由重排模型优化最终上下文。
          </p>
        </div>
        <SettingToggle v-model="draft.sparseRetrieval" />
      </div>
      <div class="kb-grid kb-grid--3">
        <label class="kb-field">
          <span class="kb-label">BM25 k1</span>
          <input
            v-model="draft.bm25K1"
            class="kb-input"
            :disabled="!draft.sparseRetrieval"
          >
        </label>
        <label class="kb-field">
          <span class="kb-label">BM25 b</span>
          <input
            v-model="draft.bm25B"
            class="kb-input"
            :disabled="!draft.sparseRetrieval"
          >
        </label>
        <label class="kb-field">
          <span class="kb-label">向量检索权重</span>
          <input
            v-model="draft.hybridWeight"
            class="kb-input"
          >
        </label>
      </div>
      <div class="kb-rerank-row">
        <SettingToggle v-model="draft.rerankEnabled" />
        <span class="kb-rerank-label">启用重排</span>
        <div class="kb-select-wrap">
          <select
            v-model="draft.rerankModel"
            class="kb-input kb-select kb-select--sm"
            :disabled="!draft.rerankEnabled"
          >
            <option
              v-for="name in RERANK_MODEL_OPTIONS"
              :key="name"
              :value="name"
            >
              {{ name }}
            </option>
            <option
              v-for="name in customModelNames"
              :key="name"
              :value="name"
            >
              {{ name }}
            </option>
          </select>
          <svg
            class="kb-select-chevron"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
        <span class="kb-inline-label">召回 Top</span>
        <input
          v-model="draft.topK"
          class="kb-input kb-input--topk"
          :disabled="!draft.rerankEnabled"
        >
      </div>
    </section>

    <!-- 知识图谱抽取 -->
    <section class="kb-card">
      <div class="kb-card-head kb-card-head--between">
        <div>
          <h2 class="kb-title">
            知识图谱抽取
          </h2>
          <p class="kb-desc">
            从文档中抽取实体、关系与属性，用于多跳关联问答。
          </p>
        </div>
        <SettingToggle v-model="draft.graphEnabled" />
      </div>
      <div class="kb-graph-field">
        <label class="kb-field">
          <span class="kb-label">抽取模型</span>
          <div class="kb-select-wrap">
            <select
              v-model="draft.graphModel"
              class="kb-input kb-select"
              :disabled="!draft.graphEnabled"
            >
              <option
                v-for="name in GRAPH_MODEL_OPTIONS"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
              <option
                v-for="name in customModelNames"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
            <svg
              class="kb-select-chevron"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </label>
        <p class="kb-hint kb-hint--tight">
          仅在启用后，对新导入文件执行实体关系抽取。
        </p>
      </div>
    </section>

    <!-- 保存反馈 -->
    <Transition name="kb-toast">
      <div
        v-if="toast"
        class="kb-toast"
      >
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.s-page {
  max-width: 1060px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 40px;
}

/* ═══════════════════ 顶部说明 + 保存 ═══════════════════ */
.kb-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.kb-intro {
  font-size: 14px;
  line-height: 1.7;
  color: var(--kw-color-text-muted);
}

.kb-intro-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.kb-save {
  flex-shrink: 0;
  padding: 8px 16px;
  font-size: 14px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.kb-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ═══════════════════ 卡片 ═══════════════════ */
.kb-card {
  border-radius: 16px;
  padding: 20px;
  background: var(--kw-color-surface);
  border: 1px solid var(--kw-color-border);
}

.kb-card--soft {
  background: var(--kw-color-bg-soft);
}

.kb-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.kb-card-head--between {
  justify-content: space-between;
  gap: 20px;
}

.kb-card-icon {
  display: inline-flex;
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--kw-color-brand);
}

.kb-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--kw-color-text);
}

.kb-desc {
  margin-top: 4px;
  font-size: 14px;
  color: var(--kw-color-text-muted);
}

/* ═══════════════════ 目录行 ═══════════════════ */
.kb-dir-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
}

.kb-dir-input {
  flex: 1;
  min-width: 0;
}

.kb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-surface);
  color: var(--kw-color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.kb-btn:hover {
  background: var(--kw-color-bg-soft);
  color: var(--kw-color-text);
}

.kb-btn-icon {
  flex-shrink: 0;
}

.kb-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--kw-color-text-faint);
}

.kb-hint--tight {
  margin-top: 8px;
}

/* ═══════════════════ 字段网格 ═══════════════════ */
.kb-grid {
  display: grid;
  gap: 16px;
  margin-top: 20px;
}

.kb-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.kb-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.kb-field {
  display: block;
  min-width: 0;
}

.kb-label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

/* ═══════════════════ 输入框 ═══════════════════ */
.kb-input {
  display: block;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
  font-size: 14px;
  font-family: inherit;
  color: var(--kw-color-text);
  outline: none;
}

.kb-input:focus {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kb-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kb-dir-input {
  background: var(--kw-color-surface);
}

/* 带单位后缀：外框承接边框，内部 input 去边框 */
.kb-unit-box {
  display: flex;
  align-items: center;
  overflow: hidden;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--kw-color-border);
  background: var(--kw-color-bg-soft);
}

.kb-unit-box .kb-input--bare {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.kb-unit-box:focus-within {
  border-color: var(--kw-color-brand);
  box-shadow: 0 0 0 3px var(--kw-color-brand-soft);
}

.kb-unit {
  flex-shrink: 0;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border-left: 1px solid var(--kw-color-border);
  font-size: 12px;
  color: var(--kw-color-text-muted);
  white-space: nowrap;
}

/* ═══════════════════ 下拉框 ═══════════════════ */
.kb-select-wrap {
  position: relative;
}

.kb-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 34px;
  cursor: pointer;
}

.kb-select-chevron {
  position: absolute;
  right: 11px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--kw-color-text-muted);
  pointer-events: none;
}

.kb-select--sm {
  width: auto;
  min-width: 210px;
  height: 36px;
  padding: 0 34px 0 12px;
  font-size: 13px;
}

.kb-select--sm + .kb-select-chevron {
  right: 10px;
}

/* ═══════════════════ 重排行 ═══════════════════ */
.kb-rerank-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--kw-color-border-soft);
}

.kb-rerank-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--kw-color-text-secondary);
}

.kb-inline-label {
  font-size: 13px;
  color: var(--kw-color-text-muted);
}

.kb-input--topk {
  width: 56px;
  flex-shrink: 0;
  height: 36px;
  padding: 0 8px;
  text-align: center;
  font-size: 13px;
}

.kb-graph-field {
  max-width: 420px;
  margin-top: 20px;
}

/* ═══════════════════ 保存 toast ═══════════════════ */
.kb-toast {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%);
  background: #2c3337;
  color: #fff;
  padding: 10px 20px;
  border-radius: 999px;
  font-size: 14px;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.kb-toast-enter-active,
.kb-toast-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.kb-toast-enter-from,
.kb-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* 窄窗口降级：并排字段折行 */
@media (max-width: 900px) {
  .kb-grid--3,
  .kb-grid--2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
